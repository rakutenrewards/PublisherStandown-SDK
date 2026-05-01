/**
 * Standdown SDK Audit Log Sample Extension: Background Service Worker
 *
 * Demonstrates the V2 pattern:
 *   - await StanddownSDK.create({ enableAuditLog: true }) at startup
 *   - Affiliate detections are automatically recorded to chrome.storage.local
 *   - Popup and Playwright tests query via sdk.getEventsByDomain(url)
 *
 * sdk.mjs is copied from dist/index.mjs by the test:e2e script before
 * Playwright launches Chrome. It must live inside the extension directory to
 * satisfy Chrome's extension sandboxing rules.
 */

import { StanddownSDK } from './sdk.mjs';

/**
 * Derive the root domain key from a URL string.
 * Matches the 2-label heuristic used by AuditLog internally.
 * Returns null for malformed URLs.
 */
function getRootDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const parts = hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SDK initialisation: synchronous construction so __sdk is available
// immediately for Playwright E2E inspection and navigation listener wiring.
//
// Production note: use `await StanddownSDK.create({ enableAuditLog: true })`
// in a production service worker to ensure the audit log is hydrated from
// chrome.storage.local before the first getEventLog()/getEventsByDomain() call.
// Top-level await is not used here because Chrome MV3 service workers can
// idle-terminate while the storage call is in flight, which would prevent the
// extension from processing the first navigation event after a restart.
// ---------------------------------------------------------------------------

// Affiliate network policies supplied at SDK initialization.
// The SDK no longer bundles default policies; integrators must provide their own.
const POLICIES = [
  {
    id: 'cj',
    schemaVersion: 2,
    policyVersion: 2,
    network: {
      id: 'cj',
      name: 'Commission Junction (CJ)',
      sessionDuration: 1800000,
    },
    rules: [
      { domain: 'dpbolvw.net', reason: 'CJ primary click-tracking domain' },
      { domain: 'anrdoezrs.net', reason: 'CJ click-tracking domain variant' },
      { domain: 'jdoqocy.com', reason: 'CJ click-tracking domain variant' },
      { domain: 'kqzyfj.com', reason: 'CJ click-tracking domain variant' },
      { domain: 'tkqlhce.com', reason: 'CJ click-tracking domain variant' },
      { domain: 'emjcd.com', reason: 'CJ redirect/tracking domain' },
      { domain: 'apmebf.com', reason: 'CJ tracking domain variant' },
      { domain: 'cc-dt.com', reason: 'CJ tracking domain variant' },
      { domain: 'ftjcfx.com', reason: 'CJ tracking domain variant' },
      { domain: 'lduhtrp.net', reason: 'CJ tracking domain variant' },
      { domain: 'tqlkg.com', reason: 'CJ tracking domain variant' },
      { domain: 'awltovhc.com', reason: 'CJ tracking domain variant' },
      { domain: 'afcyhf.com', reason: 'CJ tracking domain variant' },
      { domain: 'mbyfzn.com', reason: 'CJ tracking domain variant' },
      { domain: 'mjbpab.com', reason: 'CJ tracking domain variant' },
      { domain: 'commission-junction.com', reason: 'CJ main domain' },
      { domain: 'pjatr.com', reason: 'CJ publisher tracking domain' },
      { domain: 'pjtra.com', reason: 'CJ publisher tracking domain' },
      { domain: 'pntra.com', reason: 'CJ publisher tracking domain' },
      { domain: 'pntrac.com', reason: 'CJ publisher tracking domain' },
      { domain: 'pntrs.com', reason: 'CJ publisher tracking domain' },
      { domain: 'qksrv.net', reason: 'CJ quick-serve tracking domain' },
      { params: 'cjevent', reason: 'CJ event tracking parameter' },
    ],
  },
  {
    id: 'generic-afsrc',
    schemaVersion: 2,
    policyVersion: 2,
    network: {
      id: 'afsrc',
      name: 'Generic Affiliate Source',
      sessionDuration: 1800000,
    },
    rules: [
      { params: 'afsrc', reason: 'Standard affiliate source standdown parameter' },
    ],
  },
];

// Replace OWN_IDENTIFIERS with the publisher-specific parameters assigned to
// YOUR extension by each affiliate network. These example values are fictional
// and must not be used in a production extension.
//
// How to find your identifiers:
//   CJ:   Settings → Publisher IDs → m_si (site ID) and m_pl (publisher label)
//   eBay: Partner Network dashboard → Custom ID / tracking ID
//   Other networks: check landing-page URLs after a test click for unique params
//
// For networks that encode the publisher ID in a path segment of an intermediate
// hop (e.g. Target via goto.target.com/c/PUBLISHER_ID/), use a path regex:
//   /goto\.target\.com\/c\/12345\//
const OWN_IDENTIFIERS = [
  /m_pl=YourExtension/, // CJ: publisher label assigned by the network
  /m_si=12345/,         // CJ: publisher site ID
  /customid=yourextid/, // eBay Partner Network: custom tracking ID
  /ref=67890/,          // other networks: ref or similar parameter
  /-xfas\?/,            // Rakuten R network: path segment identifying R network affiliate links
];

const sdk = new StanddownSDK({ policies: POLICIES, enableAuditLog: true, ownAffiliatePatterns: OWN_IDENTIFIERS });

// Expose on globalThis for direct Playwright service worker evaluation.
globalThis.__sdk = sdk;

// Capture raw detection events for E2E inspection.
globalThis.__affiliateEvents = [];

// Tracks which tab last triggered a detection for each root domain.
// Parallel to the SDK's audit log; used by CHECK_AUDIT to include the
// triggering tab ID in the popup response.
const __detectionTabByDomain = new Map();
globalThis.__detectionTabByDomain = __detectionTabByDomain;

// ---------------------------------------------------------------------------
// Resolve the webNavigation namespace (same logic as StanddownSDK internally).
// Prefer globalThis.browser (Firefox / Playwright compat layer) when available.
// ---------------------------------------------------------------------------

const _webNavigation = (() => {
  try {
    const b = globalThis.browser;
    if (b?.webNavigation) return b.webNavigation;
  } catch { /* ignore */ }
  return chrome.webNavigation;
})();

// ---------------------------------------------------------------------------
// Navigation listeners: trigger detection on every completed navigation.
//
// onCompleted: primary path for normal page loads.
// onErrorOccurred: fallback for navigations that fail after the affiliate
//   redirect hop has been observed.
// onCommitted: handles multi-hop server_redirect chains.
// ---------------------------------------------------------------------------

function handleNavigationComplete({ tabId, frameId }) {
  if (frameId !== 0) return;
  const result = sdk.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;
  // Track which tab triggered detection for each root domain so the popup
  // can display "Triggered by tab X".
  const lastUrl = result.redirectChain[result.redirectChain.length - 1];
  if (lastUrl) {
    const domain = getRootDomain(lastUrl);
    if (domain) __detectionTabByDomain.set(domain, tabId);
  }
  globalThis.__affiliateEvents.push({ tabId, result, timestamp: Date.now() });
  chrome.runtime.sendMessage({ type: 'AFFILIATE_DETECTED_PUSH', tabId, result }).catch(() => {});
}

_webNavigation.onCompleted.addListener(handleNavigationComplete);
_webNavigation.onErrorOccurred.addListener(handleNavigationComplete);

_webNavigation.onCommitted.addListener(({ tabId, frameId, transitionQualifiers }) => {
  if (frameId !== 0) return;
  const qualifiers = transitionQualifiers ?? [];
  const isRedirect =
    qualifiers.includes('server_redirect') ||
    qualifiers.includes('client_redirect') ||
    qualifiers.includes('redirect');
  if (!isRedirect) return;
  const result = sdk.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;
  globalThis.__affiliateEvents.push({ tabId, result, timestamp: Date.now() });
});

// ---------------------------------------------------------------------------
// Message handler: popup sends CHECK_AUDIT to query the current tab.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CHECK_AUDIT') return false;

  const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

  if (tabId == null) {
    sendResponse(null);
    return true;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) {
      sendResponse(null);
      return;
    }
    const events = sdk.getEventsByDomain(tab.url);
    const event = events[0] ?? null;
    if (!event) {
      sendResponse(null);
      return;
    }
    const domain = getRootDomain(event.url);
    const triggerTabId = domain ? (__detectionTabByDomain.get(domain) ?? null) : null;
    sendResponse({ event, triggerTabId });
  });

  return true; // keep port open for async response
});
