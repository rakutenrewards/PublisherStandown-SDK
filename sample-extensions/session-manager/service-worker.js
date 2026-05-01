/**
 * Standdown SDK Test Extension: Background Service Worker
 *
 * Imports the built SDK from dist/, instantiates StanddownSDK, and
 * listens for CHECK_STANDDOWN messages from the popup and Playwright tests.
 */

// sdk.mjs is copied from dist/index.mjs by the test:e2e script before Playwright
// launches Chrome. It must live inside the extension directory to satisfy Chrome's
// extension sandboxing rules (extensions cannot import files from outside their root).
import { StanddownSDK } from './sdk.mjs';
import { SessionManager } from './session-manager.js';

// Resolve the webNavigation namespace the same way StanddownSDK does internally:
// prefer globalThis.browser (Firefox / Playwright compat layer) if it exposes
// webNavigation; fall back to chrome. Using the same namespace ensures our
// listeners fire on exactly the same event dispatcher as the SDK's.
const _webNavigation = (() => {
  try {
    const b = globalThis.browser;
    if (b?.webNavigation) return b.webNavigation;
  } catch { /* ignore */ }
  return chrome.webNavigation;
})();

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

// The SDK tests all URLs in the redirect chain against OWN_IDENTIFIERS and sets
// result.isOwnAffiliateLink automatically; no manual helper needed.
const sdk = new StanddownSDK({ policies: POLICIES, ownAffiliatePatterns: OWN_IDENTIFIERS });
const sessionManager = new SessionManager();

// Expose on globalThis for direct Playwright service worker evaluation.
// This avoids needing a round-trip through messaging for E2E tests.
globalThis.__sdk = sdk;
globalThis.__sessionManager = sessionManager;

// Capture detection events for E2E tests and dev inspection.
globalThis.__affiliateEvents = [];

// Most recent detection event per tab, keyed by tabId.
// Used by the popup to display detection data without opening DevTools.
globalThis.__latestCallbackByTab = new Map();

// Most recent detection event across all tabs.
// Returned by GET_CALLBACK_EVENT so every popup shows the latest detection
// regardless of which tab triggered it.
globalThis.__latestCallback = null;

// ---------------------------------------------------------------------------

/**
 * Wraps checkForAffiliatePatterns() and produces a shouldStanddown decision.
 * isOwnAffiliateLink is set by the SDK based on the configured ownAffiliatePatterns.
 *
 * Exposed on globalThis so Playwright tests can call it directly via
 * sw.evaluate(() => globalThis.__checkStanddown(tabId)) without a message
 * round-trip. This is test scaffolding; in a real extension this logic
 * belongs inside the onMessage handler only.
 *
 * @param {number} tabId
 * @returns {{ hasAffiliatePattern: boolean, matchedPatterns: object[],
 *             redirectChain: string[], isOwnAffiliateLink: boolean,
 *             shouldStanddown: boolean,
 *             reason: 'no_affiliate_detected'|'own_link'|'competitor_detected' }}
 */
globalThis.__checkStanddown = function (tabId) {
  const result = sdk.checkForAffiliatePatterns(tabId);
  return {
    ...result,
    isOwnLink: result.isOwnAffiliateLink,
    shouldStanddown: result.hasAffiliatePattern && !result.isOwnAffiliateLink,
    reason: !result.hasAffiliatePattern
      ? 'no_affiliate_detected'
      : result.isOwnAffiliateLink
        ? 'own_link'
        : 'competitor_detected',
  };
};

// Clear per-tab callback state when a tab is closed to keep memory bounded.
// The SDK registers its own tabs.onRemoved listener internally for tracker
// cleanup; this is a separate, independent listener for our popup state.
//
// Skip deletion when an active session exists for that tab's domain: the
// entry is the only way to recover the final URL for a closed tab, which the
// CHECK_STANDDOWN handler needs to look up the session. Cleanup happens lazily
// inside CHECK_STANDDOWN once the session expires.
chrome.tabs.onRemoved.addListener((tabId) => {
  const event = globalThis.__latestCallbackByTab.get(tabId);
  if (!event) return;
  const lastUrl = event.result?.redirectChain?.at(-1) ?? null;
  const session = lastUrl ? sessionManager.getSession(lastUrl) : null;
  if (!session) {
    globalThis.__latestCallbackByTab.delete(tabId);
  }
});

// ---------------------------------------------------------------------------
// Proactive detection on navigation completion.
//
// Direct listeners on onCompleted and onErrorOccurred replace the former
// sdk.onAffiliateDetected() subscribers. Using _webNavigation (same namespace
// as the SDK's tracker) ensures registration-order guarantees are preserved;
// the SDK's tracker listeners fire before ours, so the chain is fully built
// by the time handleNavigationComplete runs.
//
// Both triggers are needed:
// - onCompleted: primary path for normal navigations
// - onErrorOccurred: fallback for navigations that fail at the network level
//   after the affiliate redirect hop has already been observed
//
// The onCommitted listener below handles multi-hop server_redirect chains.
// ---------------------------------------------------------------------------

function handleNavigationComplete({ tabId, frameId }) {
  if (frameId !== 0) return;
  const result = sdk.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;

  // Session recording (single-hop and direct navigation paths)
  const finalUrl = result.redirectChain[result.redirectChain.length - 1];
  if (finalUrl) sessionManager.record(finalUrl, result, tabId);

  // Event capture for Playwright inspection and popup live update
  const event = { tabId, result, timestamp: Date.now() };
  globalThis.__affiliateEvents.push({ tabId, result });
  globalThis.__latestCallbackByTab.set(tabId, event);
  globalThis.__latestCallback = event;
  chrome.runtime.sendMessage({ type: 'AFFILIATE_DETECTED_PUSH', tabId, result }).catch(() => {});
}

_webNavigation.onCompleted.addListener(handleNavigationComplete);
_webNavigation.onErrorOccurred.addListener(handleNavigationComplete);

_webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  console.log(`[webNav] tab ${tabId} onBeforeNavigate: ${url}`);
});

_webNavigation.onCommitted.addListener(({ tabId, frameId, url, transitionQualifiers }) => {
  if (frameId !== 0) return;
  const qualifiers = transitionQualifiers ?? [];
  const isRedirect =
    qualifiers.includes('server_redirect') ||
    qualifiers.includes('client_redirect') ||
    qualifiers.includes('redirect');

  if (!isRedirect) {
    console.log(`[webNav] tab ${tabId} onCommitted RESET (qualifiers: [${qualifiers.join(', ')}]): ${url}`);
    return;
  }

  console.log(`[webNav] tab ${tabId} onCommitted redirect-continue (qualifiers: [${qualifiers.join(', ')}]): ${url}`);

  // Only process redirect continuations; the onCompleted path already
  // handles non-redirect (user-initiated) navigations.
  const result = sdk.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;
  // Use the committed URL from the event, NOT result.redirectChain[last].
  // onBeforeNavigate does not fire for the redirect target when Playwright
  // intercepts a 302, so the chain hasn't grown to include this URL yet.
  // The event url IS the merchant URL to key the session to.
  sessionManager.record(url, result, tabId);
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CALLBACK_EVENT') {
    sendResponse(globalThis.__latestCallback ?? null);
    return true;
  }

  if (message.type !== 'CHECK_STANDDOWN') return false;

  const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;

  if (tabId == null) {
    sendResponse({
      hasAffiliatePattern: false,
      matchedPatterns: [],
      redirectChain: [],
      isOwnAffiliateLink: false,
      shouldStanddown: false,
      reason: 'no_affiliate_detected',
      session: null,
    });
    return true;
  }

  // Live detection is synchronous (reads from NavigationTracker in-memory state).
  const liveResult = globalThis.__checkStanddown(tabId);

  // Session lookup requires the tab's current URL, which is an async operation.
  // chrome.tabs.get may fail if the tab was closed between the message being sent
  // and this handler running; handle gracefully via chrome.runtime.lastError.
  chrome.tabs.get(tabId, (tab) => {
    // When the tab is closed, fall back to the last known URL from callback state
    // so we can still look up an active session for the domain.
    let tabUrl = tab?.url ?? null;
    if (chrome.runtime.lastError || !tabUrl) {
      const lastEvent = globalThis.__latestCallbackByTab.get(tabId);
      tabUrl = lastEvent?.result?.redirectChain?.at(-1) ?? null;
    }

    const session = tabUrl ? sessionManager.getSession(tabUrl) : null;

    // If the session has expired (or never existed), remove the stale entry.
    if (!session) globalThis.__latestCallbackByTab.delete(tabId);

    // Session-based stand-down: a prior session exists AND the link is not own.
    const sessionActive = session !== null && !liveResult.isOwnAffiliateLink;
    const shouldStanddown = liveResult.shouldStanddown || sessionActive;
    const reason = liveResult.shouldStanddown
      ? liveResult.reason
      : sessionActive
        ? 'session_active'
        : liveResult.reason;

    sendResponse({ ...liveResult, shouldStanddown, reason, session });
  });

  return true; // keep port open for async response
});
