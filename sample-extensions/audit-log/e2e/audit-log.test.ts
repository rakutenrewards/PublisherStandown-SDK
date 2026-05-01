/**
 * Standdown SDK: Audit Log E2E Tests (EPIC3-006)
 *
 * Validates the V2 audit log pattern against real Chromium webNavigation events:
 *
 * 1. Affiliate navigation → entry in sdk.getEventsByDomain()
 * 2. Clean navigation → no entry
 * 3. Re-detection on same domain → prior entry overwritten (timestamp updated)
 * 4. Expired session → getEventsByDomain() returns [] after sessionDuration elapses
 * 5. getEventLog() returns all active entries across multiple domains
 *
 * Test strategy:
 * - Launch Chromium with the audit-log sample extension via launchPersistentContext.
 * - Simulate affiliate navigations via context.route() returning 200 with ?afsrc=1
 *   on the destination URL (matches the embedded generic-afsrc policy). Using single-hop
 *   navigations avoids relay routing issues with 302-redirect chains in Chrome extension
 *   contexts; the audit log recording logic is identical regardless of hop count.
 * - Evaluate sdk.getEventsByDomain() / sdk.getEventLog() directly in the service
 *   worker context to avoid popup round-trips.
 */

import { test, expect } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtensionContext } from './helpers/extension-context.js';
import { startLocalServer, stopLocalServer } from './helpers/local-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Shared browser context (one Chromium instance per test file)
// A fresh page is created per test so context.route() interception applies.
// ---------------------------------------------------------------------------

let context: BrowserContext;
let sw: Worker;
let extensionOrigin: string;
let page: Page;

test.beforeAll(async () => {
  ({ context, sw, extensionOrigin } = await launchExtensionContext(EXTENSION_PATH));
});

test.afterAll(async () => {
  await context.close();
});

test.beforeEach(async () => {
  page = await context.newPage();
});

test.afterEach(async () => {
  await page.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register a one-shot route that serves url with status 200.
 * The URL must contain ?afsrc=1 so the embedded generic-afsrc policy fires.
 */
async function registerAffiliateUrl(url: string): Promise<void> {
  await context.route(
    (u) => u.toString() === url,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
}

/** Navigate to url and wait for the service worker navigation listeners to fire. */
async function navigate(url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' });
  // Allow one tick for the service worker's navigation listeners to fire.
  await page.waitForTimeout(200);
}

/** Query sdk.getEventsByDomain(input) in the service worker. */
async function getEventsByDomain(input: string) {
  return sw.evaluate(
    ([i]) => (globalThis as Record<string, unknown>)['__sdk']
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (globalThis as any).__sdk.getEventsByDomain(i)
      : [],
    [input],
  );
}

/** Query sdk.getEventLog() in the service worker. */
async function getEventLog() {
  return sw.evaluate(
    () => (globalThis as Record<string, unknown>)['__sdk']
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (globalThis as any).__sdk.getEventLog()
      : [],
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: Affiliate navigation produces an audit log entry
// ---------------------------------------------------------------------------

test('affiliate navigation → entry in getEventsByDomain()', async () => {
  // ?afsrc=1 matches the embedded generic-afsrc policy. The URL is intercepted
  // by context.route() so no real network request is made.
  // Use a distinct root domain (not *.example.com) to avoid cross-test contamination.
  const URL = 'https://audit-merchant-detected.com/?afsrc=1&smoke=audit-1';
  await registerAffiliateUrl(URL);
  await navigate(URL);

  const events = await getEventsByDomain('audit-merchant-detected.com');
  expect(Array.isArray(events)).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0].url).toBe(URL);
  expect(typeof events[0].timestamp).toBe('number');
  expect(typeof events[0].sessionDuration).toBe('number');
  expect(events[0].sessionDuration).toBeGreaterThan(0);
  expect(Array.isArray(events[0].matchedPatterns)).toBe(true);
  expect(events[0].matchedPatterns).toHaveLength(1);
  expect(events[0].matchedPatterns[0].network).toBe('afsrc');
  expect(Array.isArray(events[0].redirectChain)).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 2: Clean navigation produces no audit log entry
// ---------------------------------------------------------------------------

test('clean navigation → getEventsByDomain() returns []', async () => {
  // Use a domain that has never had an affiliate detection (no afsrc param).
  await context.route(
    (url) => url.toString() === 'https://audit-merchant-clean.com/',
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
  await page.goto('https://audit-merchant-clean.com/', { waitUntil: 'commit' });
  await page.waitForTimeout(200);

  const events = await getEventsByDomain('audit-merchant-clean.com');
  expect(events).toEqual([]);
});

// ---------------------------------------------------------------------------
// Scenario 3: Re-detection on same domain overwrites the prior entry
// ---------------------------------------------------------------------------

test('re-detection on same domain → prior entry overwritten (timestamp updated)', async () => {
  const MERCHANT = 'audit-merchant-overwrite.com';
  const URL1 = `https://${MERCHANT}/?afsrc=1&v=1`;
  const URL2 = `https://${MERCHANT}/?afsrc=1&v=2`;

  // First detection
  await registerAffiliateUrl(URL1);
  await navigate(URL1);

  const firstEvents = await getEventsByDomain(MERCHANT);
  expect(firstEvents).toHaveLength(1);
  const firstTimestamp: number = firstEvents[0].timestamp;

  // Brief pause so timestamps differ, then a fresh page for the second navigation
  await new Promise((r) => setTimeout(r, 50));
  await page.close();
  page = await context.newPage();

  // Second detection on the same root domain
  await registerAffiliateUrl(URL2);
  await navigate(URL2);

  const secondEvents = await getEventsByDomain(MERCHANT);
  expect(secondEvents).toHaveLength(1); // still exactly one entry
  expect(secondEvents[0].timestamp).toBeGreaterThanOrEqual(firstTimestamp);
  expect(secondEvents[0].url).toBe(URL2);
});

// ---------------------------------------------------------------------------
// Scenario 4: Expired entry → getEventsByDomain() returns []
// ---------------------------------------------------------------------------

test('expired session → getEventsByDomain() returns [] after sessionDuration elapses', async () => {
  const baseTime = Date.now();
  const URL = 'https://audit-merchant-expiry.com/?afsrc=1&smoke=expiry';
  await registerAffiliateUrl(URL);
  await navigate(URL);

  // Confirm entry is present before expiry
  const before = await getEventsByDomain('audit-merchant-expiry.com');
  expect(before).toHaveLength(1);
  const sessionDuration: number = before[0].sessionDuration;

  // Advance the service worker's clock past the session duration
  await sw.evaluate(
    ([future]) => {
      const origNow = Date.now;
      // Override once; the audit log's lazy expiry check will use this value.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Date as any).now = () => future;
      // Restore after a tick so other SDK operations are unaffected.
      setTimeout(() => { Date.now = origNow; }, 2_000);
    },
    [baseTime + sessionDuration + 1_000],
  );

  const after = await getEventsByDomain('audit-merchant-expiry.com');
  expect(after).toEqual([]);
});

// ---------------------------------------------------------------------------
// Scenario 5: getEventLog() returns all active entries across multiple domains
// ---------------------------------------------------------------------------

test('getEventLog() returns all active entries across multiple domains', async () => {
  // Use distinct root domains (not same-root subdomains like *.example.com) so
  // AuditLog stores two separate entries rather than overwriting the first.
  const URL_A = 'https://audit-multi-alpha.com/?afsrc=1&smoke=multi-a';
  const URL_B = 'https://audit-multi-beta.com/?afsrc=1&smoke=multi-b';

  await registerAffiliateUrl(URL_A);
  await navigate(URL_A);

  // Create a fresh page for the second navigation
  await page.close();
  page = await context.newPage();

  await registerAffiliateUrl(URL_B);
  await navigate(URL_B);

  const log = await getEventLog();
  expect(Array.isArray(log)).toBe(true);
  // At minimum the two domains we just recorded should be present.
  const urls: string[] = log.map((e: { url: string }) => e.url);
  expect(urls.some((u) => u.includes('audit-multi-alpha.com'))).toBe(true);
  expect(urls.some((u) => u.includes('audit-multi-beta.com'))).toBe(true);
});

// ---------------------------------------------------------------------------
// Popup UI helpers
// ---------------------------------------------------------------------------

/** Resolve the tabId for the tab whose URL contains the given fragment. */
async function getTabId(urlFragment: string): Promise<number> {
  return sw.evaluate(async (fragment: string) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const tabs: chrome.tabs.Tab[] = await new Promise((resolve) =>
        chrome.tabs.query({}, resolve),
      );
      const tab = tabs.find((t) => t.url?.includes(fragment));
      if (tab?.id != null) return tab.id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`No tab found with URL fragment: ${fragment}`);
  }, urlFragment) as Promise<number>;
}

/** Open the extension popup for a specific tab and return the Playwright page. */
async function openPopup(tabId: number) {
  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup/popup.html?tabId=${tabId}`);
  return popup;
}

// ---------------------------------------------------------------------------
// Popup UI-1: event details shown after affiliate navigation
// ---------------------------------------------------------------------------

test('Popup UI-1: shows event details with chain and patterns after affiliate navigation', async () => {
  const URL = 'https://audit-popup-details.com/?afsrc=1&smoke=popup-1';
  await registerAffiliateUrl(URL);
  await navigate(URL);

  const tabId = await getTabId('smoke=popup-1');
  const popup = await openPopup(tabId);

  await expect(popup.locator('#status')).toHaveClass(/match/);
  await expect(popup.locator('#status')).toContainText('Active affiliate session');

  // Structured fields
  await expect(popup.locator('#event-domain')).toContainText('audit-popup-details.com');
  await expect(popup.locator('#event-timestamp')).not.toHaveText('');
  await expect(popup.locator('#event-expires')).not.toHaveText('');
  await expect(popup.locator('#event-networks')).toContainText('afsrc');

  // Redirect chain and match entry
  await expect(popup.locator('#redirect-chain-section')).toBeVisible();
  const items = popup.locator('#redirect-chain li');
  expect(await items.count()).toBeGreaterThan(0);
  await expect(popup.locator('.match-network').first()).toContainText('afsrc');
  await expect(popup.locator('.match-rule').first()).toHaveText('Rule: params');

  // Tab indicator must be populated
  const tabText = await popup.locator('#event-tab').textContent();
  expect(tabText?.trim().length).toBeGreaterThan(0);

  await popup.close();
});

// ---------------------------------------------------------------------------
// Popup UI-2: no-session state
// ---------------------------------------------------------------------------

test('Popup UI-2: shows "No active affiliate session" for domain with no detection', async () => {
  await context.route(
    (u) => u.toString() === 'https://audit-popup-clean.com/',
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
  await page.goto('https://audit-popup-clean.com/');
  await page.waitForTimeout(200);

  const tabId = await getTabId('audit-popup-clean.com');
  const popup = await openPopup(tabId);

  await expect(popup.locator('#status')).toHaveClass(/clean/);
  await expect(popup.locator('#status')).toContainText('No active affiliate session');
  await expect(popup.locator('#event-none')).toBeVisible();
  await expect(popup.locator('#event-details')).not.toBeVisible();

  await popup.close();
});

// ---------------------------------------------------------------------------
// Popup UI-3: push-driven live update from background tab
// ---------------------------------------------------------------------------

test('Popup UI-3: popup updates live when background tab triggers detection on same domain', async () => {
  // Tab A: open a page on the domain with no prior detection.
  await context.route(
    (u) => u.toString() === 'https://audit-popup-push.com/',
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
  const pageA = await context.newPage();
  await pageA.goto('https://audit-popup-push.com/');
  const tabAId = await getTabId('audit-popup-push.com');

  // Open popup for Tab A; should show no-session state.
  const popup = await openPopup(tabAId);
  await expect(popup.locator('#status')).toContainText('No active affiliate session');

  // Tab B: navigate to the same root domain with an affiliate signal.
  const affiliateUrl = 'https://audit-popup-push.com/?afsrc=1&smoke=push-b';
  await context.route(
    (u) => u.toString() === affiliateUrl,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );
  const pageB = await context.newPage();
  await pageB.goto(affiliateUrl, { waitUntil: 'commit' });
  await pageB.waitForTimeout(200);
  const tabBId = await getTabId('smoke=push-b');

  // Popup for Tab A must update live via push.
  await expect(popup.locator('#status')).toContainText('Active affiliate session', { timeout: 3000 });
  await expect(popup.locator('#event-networks')).toContainText('afsrc');

  // Tab indicator must reference Tab B (the triggering tab).
  await expect(popup.locator('#event-tab')).toContainText(String(tabBId));

  await popup.close();
  await pageB.close();
  await pageA.close();
});

// ---------------------------------------------------------------------------
// WR-1: real 302 chain — intermediate hop appears in audit log
//
// Uses a local Node.js HTTP server producing genuine 302 responses.
// The intermediate hop URL (/wr1-b?cjevent=wr1) matches the CJ params rule,
// so the audit log must record an entry with redirectChain.length === 3.
// ---------------------------------------------------------------------------

test.describe('WR-1: real 302 chain — intermediate hop in audit log', () => {
  const WR1_PORT = 19877;
  let wr1Server: Server;

  test.beforeAll(async () => {
    wr1Server = await startLocalServer(WR1_PORT);
  });

  test.afterAll(async () => {
    await stopLocalServer(wr1Server);
  });

  test('real 302 redirect chain: intermediate hop recorded in audit log with redirectChain length 3', async () => {
    const wr1Page = await context.newPage();
    await wr1Page.goto(`http://127.0.0.1:${WR1_PORT}/wr1-a`, { waitUntil: 'load' });

    // Poll until the audit log records the event (onCompleted fires asynchronously).
    const events = await sw.evaluate(async () => {
      const deadline = Date.now() + 4000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = (globalThis as any).__sdk;
      while (Date.now() < deadline) {
        const evts = sdk?.getEventsByDomain('127.0.0.1') ?? [];
        if (evts.length > 0) return evts;
        await new Promise((r) => setTimeout(r, 100));
      }
      return sdk?.getEventsByDomain('127.0.0.1') ?? [];
    }) as Array<{ redirectChain: string[] }>;

    await wr1Page.close();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].redirectChain.length).toBe(3);
  });
});
