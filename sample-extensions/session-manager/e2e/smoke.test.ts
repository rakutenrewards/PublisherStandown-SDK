/**
 * Standdown SDK: E2E Smoke Tests
 *
 * Three scenarios that mirror the integration tests from Epic 3, now validated
 * against real Chromium webNavigation events instead of mocks:
 *
 * 1. CJ cjevent param on page URL → hasAffiliatePattern: true, network: cj
 * 2. afsrc=1 param on page URL    → hasAffiliatePattern: true, network: afsrc
 * 3. Clean page URL               → hasAffiliatePattern: false
 *
 * Test strategy:
 * - Launch Chromium with the test-extension loaded via launchPersistentContext.
 * - Each test navigates to example.com with a unique query param so we can find
 *   the tab by URL from the service worker context.
 * - Detection is checked by evaluating directly in the service worker; this
 *   avoids popup UI interaction while exercising the same shield.checkForAffiliatePatterns()
 *   call path that real users trigger via the popup.
 *
 * Network note:
 * - All tests navigate to example.com (always reachable in CI) to avoid
 *   real affiliate domain dependencies. Detection correctness depends on URL
 *   query params, which the bundled policies match without any network traffic.
 */

import { test, expect } from '@playwright/test';
import type { BrowserContext, Worker } from '@playwright/test';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupRedirectChainHelper, registerChain } from './helpers/redirect-chain-helper.js';
import { launchExtensionContext } from './helpers/extension-context.js';
import { startLocalServer, stopLocalServer } from './helpers/local-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the test-extension directory (contains manifest.json). */
const EXTENSION_PATH = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Shared browser context (one Chromium instance for all 3 tests)
// ---------------------------------------------------------------------------

let context: BrowserContext;
let sw: Worker;
let extensionOrigin: string;

test.beforeAll(async () => {
  ({ context, sw, extensionOrigin } = await launchExtensionContext(EXTENSION_PATH));
  await setupRedirectChainHelper(context);
});

test.afterAll(async () => {
  await context.close();
});

// ---------------------------------------------------------------------------
// Helper: detect patterns for the tab whose URL contains a given fragment
// ---------------------------------------------------------------------------

interface DetectionResult {
  hasAffiliatePattern: boolean;
  matchedPatterns: Array<{ network: string; rule: unknown; url: string }>;
  redirectChain: string[];
}

async function checkTab(urlFragment: string): Promise<DetectionResult> {
  return sw.evaluate(async (fragment: string) => {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const tab = tabs.find((t) => t.url?.includes(fragment));
        const tabId = tab?.id;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const shield = (globalThis as any).__sdk as {
          checkForAffiliatePatterns: (id: number) => unknown;
        };
        if (!tabId || !shield) {
          resolve({ hasAffiliatePattern: false, matchedPatterns: [], redirectChain: [] });
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve(shield.checkForAffiliatePatterns(tabId) as any);
      });
    });
  }, urlFragment) as Promise<DetectionResult>;
}

// ---------------------------------------------------------------------------
// StanddownCheckResult: extended result returned by __checkStanddown
// ---------------------------------------------------------------------------

interface StanddownCheckResult extends DetectionResult {
  isOwnLink: boolean;
  shouldStanddown: boolean;
  reason: 'no_affiliate_detected' | 'own_link' | 'competitor_detected';
}

/**
 * Calls globalThis.__checkStanddown(tabId) in the service worker context for
 * the tab whose URL contains the given fragment. Returns the extended result
 * that includes shouldStanddown, isOwnLink, and reason.
 */
async function checkStanddown(urlFragment: string): Promise<StanddownCheckResult> {
  return sw.evaluate(async (fragment: string) => {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const tab = tabs.find((t) => t.url?.includes(fragment));
        const tabId = tab?.id;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const checkFn = (globalThis as any).__checkStanddown as
          | ((id: number) => unknown)
          | undefined;
        if (!tabId || !checkFn) {
          resolve({
            hasAffiliatePattern: false,
            matchedPatterns: [],
            redirectChain: [],
            isOwnLink: false,
            shouldStanddown: false,
            reason: 'no_affiliate_detected',
          });
          return;
        }
        resolve(checkFn(tabId) as StanddownCheckResult);
      });
    });
  }, urlFragment) as Promise<StanddownCheckResult>;
}

// ---------------------------------------------------------------------------
// Scenario 1: CJ event param in URL → detected as CJ
// ---------------------------------------------------------------------------

test('Scenario 1: CJ cjevent param on page URL → hasAffiliatePattern true, network cj', async () => {
  const page = await context.newPage();

  // Navigate to example.com with the CJ `cjevent` tracking param.
  // The embedded CJ policy has: { params: "cjevent", reason: "CJ event tracking parameter" }
  // onBeforeNavigate fires → URL added to chain
  // onCommitted fires (no redirect qualifiers) → chain resets to [this URL]
  await page.goto('https://example.com/?cjevent=smoke-test-1');

  const result = await checkTab('cjevent=smoke-test-1');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(true);
  expect(result.matchedPatterns.some((m) => m.network === 'cj')).toBe(true);
  expect(result.redirectChain.some((url) => url.includes('cjevent'))).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 2: afsrc=1 on page URL → detected (via user policy in service worker)
// ---------------------------------------------------------------------------

test('Scenario 2: afsrc=1 param on page URL → hasAffiliatePattern true', async () => {
  const page = await context.newPage();

  // The embedded generic-afsrc policy matches any URL with ?afsrc=.
  await page.goto('https://example.com/?afsrc=1&smoke=2');

  const result = await checkTab('afsrc=1&smoke=2');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(true);
  expect(result.matchedPatterns.some((m) => m.network === 'afsrc')).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 3: Clean navigation → no affiliate pattern
// ---------------------------------------------------------------------------

test('Scenario 3: clean page URL → hasAffiliatePattern false', async () => {
  const page = await context.newPage();

  // example.com with no affiliate params; no embedded or user policy matches.
  await page.goto('https://example.com/?smoke=3-clean');

  const result = await checkTab('smoke=3-clean');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(false);
  expect(result.matchedPatterns).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Scenario 4: two-hop chain with CJ affiliate domain → detected as CJ
// ---------------------------------------------------------------------------

test('Scenario 4: two-hop chain via dpbolvw.net → hasAffiliatePattern true, network cj, redirectChain length 2', async () => {
  // Register a two-hop chain:
  //   https://dpbolvw.net/click-smoke-4  →  302  →  https://example.com/?smoke=4-merchant
  //   https://example.com/?smoke=4-merchant  →  200
  //
  // dpbolvw.net is a CJ affiliate redirect domain. NavigationTracker sees
  // server_redirect on the second hop and preserves the full chain, so
  // checkForAffiliatePatterns fires the CJ domain rule on the intermediate URL.
  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-smoke-4',
    'https://example.com/?smoke=4-merchant',
  ]);

  const page = await context.newPage();
  await page.goto(entryUrl);

  const result = await checkTab('smoke=4-merchant');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(true);
  expect(result.matchedPatterns.some((m) => m.network === 'cj')).toBe(true);
  expect(result.redirectChain).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Scenario 6: detection event fires after redirect chain settles
// ---------------------------------------------------------------------------

test('Scenario 6: detection event fires with correct payload after CJ redirect chain', async () => {
  // Clear any events captured by previous tests.
  await sw.evaluate(() => {
    (globalThis as unknown as Record<string, unknown[]>)['__affiliateEvents'] = [];
  });

  // Two-hop chain: CJ click domain → merchant landing page.
  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-smoke-6',
    'https://example.com/?smoke=6-merchant',
  ]);

  const page = await context.newPage();
  await page.goto(entryUrl);
  await page.close();

  // Poll until the service worker has processed at least one onCompleted event
  // (there can be a short lag between page load and the extension event dispatch).
  type CapturedEvent = { tabId: number; result: { hasAffiliatePattern: boolean; matchedPatterns: Array<{ network: string }>; redirectChain: string[] } };
  const events = await sw.evaluate(async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const evts = (globalThis as Record<string, unknown>)['__affiliateEvents'] as unknown[];
      if (evts.length > 0) return evts;
      await new Promise((r) => setTimeout(r, 50));
    }
    return (globalThis as Record<string, unknown>)['__affiliateEvents'];
  }) as CapturedEvent[];

  // With Playwright route interception, onCompleted may fire for the affiliate
  // hop (dpbolvw.net) rather than only the final destination; filter by the
  // affiliate domain which is guaranteed to be in the chain regardless of timing.
  expect(events.length).toBeGreaterThanOrEqual(1);
  const event = events.find((e) =>
    e.result.redirectChain.some((url) => url.includes('dpbolvw.net')),
  );
  expect(event).toBeDefined();
  expect(event!.result.hasAffiliatePattern).toBe(true);
  expect(event!.result.matchedPatterns.some((m) => m.network === 'cj')).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 5: two-hop chain with no affiliate signals → not detected
// ---------------------------------------------------------------------------

test('Scenario 5: two-hop clean chain → hasAffiliatePattern false', async () => {
  // Register a two-hop chain where neither URL contains any affiliate signal.
  // NavigationTracker preserves the full chain via server_redirect, but
  // checkForAffiliatePatterns finds no matching policy rules for either URL.
  const entryUrl = await registerChain([
    'https://example.com/?smoke=5-hop1',
    'https://example.com/?smoke=5-hop2',
  ]);

  const page = await context.newPage();
  await page.goto(entryUrl);

  const result = await checkTab('smoke=5-hop2');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(false);
  expect(result.matchedPatterns).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Scenario 7: own CJ link (single hop) → shouldStanddown false, isOwnLink true
// ---------------------------------------------------------------------------

test('Scenario 7: own CJ link with own publisher identifiers → shouldStanddown false, isOwnLink true', async () => {
  const page = await context.newPage();

  // Navigate to a URL that carries both a CJ affiliate signal (cjevent) and
  // this extension's own publisher identifiers (m_pl=YourExtension, m_si=12345).
  // The SDK detects the CJ pattern; isOwnAffiliateLink() then recognises the
  // m_pl and m_si values from OWN_IDENTIFIERS → shouldStanddown must be false.
  await page.goto('https://example.com/?cjevent=smoke-7&m_pl=YourExtension&m_si=12345');

  const result = await checkStanddown('cjevent=smoke-7');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(true);
  expect(result.isOwnLink).toBe(true);
  expect(result.shouldStanddown).toBe(false);
  expect(result.reason).toBe('own_link');
});

// ---------------------------------------------------------------------------
// Scenario 8: competitor CJ link (single hop) → shouldStanddown true
// ---------------------------------------------------------------------------

test('Scenario 8: competitor CJ link with foreign publisher identifier → shouldStanddown true', async () => {
  const page = await context.newPage();

  // Navigate to a URL with a CJ affiliate signal but a competitor's publisher
  // label (m_pl=Competitor). The SDK detects the CJ pattern; isOwnAffiliateLink()
  // finds no match in OWN_IDENTIFIERS → shouldStanddown must be true.
  await page.goto('https://example.com/?cjevent=smoke-8&m_pl=Competitor');

  const result = await checkStanddown('cjevent=smoke-8');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(true);
  expect(result.isOwnLink).toBe(false);
  expect(result.shouldStanddown).toBe(true);
  expect(result.reason).toBe('competitor_detected');
});

// ---------------------------------------------------------------------------
// Scenario 9: own CJ link (two-hop chain) → shouldStanddown false
// ---------------------------------------------------------------------------

test('Scenario 9: own CJ link across two-hop redirect chain → shouldStanddown false', async () => {
  // Register a two-hop chain: CJ click-tracking URL → merchant landing page.
  //
  // Publisher identifiers are placed in the click-tracker URL's query string.
  // With Playwright route interception, Chrome's onBeforeNavigate fires for the
  // entry URL but not reliably for the redirect target; the NavigationTracker
  // chain therefore contains the click-tracker URL. isOwnAffiliateLink() checks
  // the last URL in the chain, where our identifiers are present, and returns
  // true → shouldStanddown must be false.
  //
  // This mirrors the real pattern where some networks (e.g. CJ's deep-link
  // builder) carry the publisher label as a query parameter on the click URL.
  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-smoke-9?m_pl=YourExtension&m_si=12345',
    'https://example.com/?smoke=9-own',
  ]);

  const page = await context.newPage();
  await page.goto(entryUrl);

  const result = await checkStanddown('smoke=9-own');
  await page.close();

  expect(result.hasAffiliatePattern).toBe(true);
  expect(result.isOwnLink).toBe(true);
  expect(result.shouldStanddown).toBe(false);
  expect(result.reason).toBe('own_link');
});

// ---------------------------------------------------------------------------
// Popup UI tests: assert #callback-section DOM renders correctly
// ---------------------------------------------------------------------------

/**
 * Returns the tabId of the first tab whose URL contains the given fragment,
 * polling until found or a 2-second deadline is reached.
 */
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

// ---------------------------------------------------------------------------
// Session Manager: types and helpers
// ---------------------------------------------------------------------------

interface SessionRecord {
  detectedAt: number;
  result: DetectionResult;
  tabId: number;
}

/** Clear all session manager entries for test isolation. */
async function clearSessionManager(): Promise<void> {
  await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__sessionManager.clear();
  });
}

/** Return the session for the given URL directly from the session manager. */
async function getSessionForUrl(url: string): Promise<SessionRecord | null> {
  return sw.evaluate((u: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).__sessionManager.getSession(u) ?? null;
  }, url) as Promise<SessionRecord | null>;
}

/**
 * Poll until the session manager has a record for the root domain of `url`,
 * then return it. Throws after timeoutMs if no session appears.
 */
async function waitForSession(url: string, timeoutMs = 2000): Promise<SessionRecord> {
  return sw.evaluate(
    async ([u, ms]: [string, number]) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = (globalThis as any).__sessionManager.getSession(u);
        if (s !== null) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Session not found for URL within timeout: ${u}`);
    },
    [url, timeoutMs] as [string, number],
  ) as Promise<SessionRecord>;
}

// ---------------------------------------------------------------------------
// SESSION-A: popup SESSION section shows chain, patterns, and tab
// ---------------------------------------------------------------------------

test('SESSION-A: SESSION section shows redirect chain, matched pattern, and triggering tab after affiliate navigation', async () => {
  await clearSessionManager();

  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-sa',
    'https://example.com/?smoke=sa-merchant',
  ]);
  const page = await context.newPage();
  await page.goto(entryUrl);
  await waitForSession('https://example.com/?smoke=sa-merchant');

  const tabId = await getTabId('smoke=sa-merchant');
  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup/popup.html?tabId=${tabId}`);

  await expect(popup.locator('#session-status')).toHaveText('Session active');
  await expect(popup.locator('#session-detection')).toBeVisible();

  // Redirect chain must contain the CJ affiliate hop.
  const items = popup.locator('#redirect-chain li');
  expect(await items.count()).toBeGreaterThan(0);
  const chainText = await items.allTextContents();
  expect(chainText.some((t) => t.includes('dpbolvw.net'))).toBe(true);

  // Match entry must show CJ network.
  await expect(popup.locator('.match-network').first()).toContainText('cj');

  // Tab indicator must be non-empty.
  const tabText = await popup.locator('#session-tab').textContent();
  expect(tabText?.trim().length).toBeGreaterThan(0);

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// SESSION-B: SESSION and DECISION update live from a background tab
// ---------------------------------------------------------------------------

test('SESSION-B: SESSION and DECISION update live when background tab establishes affiliate session', async () => {
  await clearSessionManager();

  // Tab A: clean navigation on example.com; no session yet.
  const pageA = await context.newPage();
  await pageA.goto('https://example.com/?smoke=sb-clean');
  const tabAId = await getTabId('smoke=sb-clean');

  // Open popup for Tab A; SESSION shows "No session", DECISION shows "No stand-down".
  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup/popup.html?tabId=${tabAId}`);
  await expect(popup.locator('#session-status')).toHaveText('No session');
  await expect(popup.locator('#decision-status')).toHaveText('No stand-down');

  // Tab B: navigate through CJ affiliate redirect to the same root domain (example.com).
  // This establishes a session for example.com in the session manager.
  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-sb',
    'https://example.com/?smoke=sb-affiliate',
  ]);
  const pageB = await context.newPage();
  await pageB.goto(entryUrl);
  const tabBId = await getTabId('smoke=sb-affiliate');
  await waitForSession('https://example.com/?smoke=sb-affiliate');

  // Popup for Tab A must update live via push: SESSION active, DECISION stands down,
  // tab indicator shows the background tab (Tab B) that created the session.
  await expect(popup.locator('#session-status')).toHaveText('Session active', { timeout: 3000 });
  await expect(popup.locator('#decision-status')).toHaveText('Stand down', { timeout: 3000 });
  await expect(popup.locator('#session-tab')).toContainText(String(tabBId));
  await expect(popup.locator('#session-detection')).toBeVisible();
  await expect(popup.locator('.match-network').first()).toContainText('cj');

  await popup.close();
  await pageB.close();
  await pageA.close();
});

// ---------------------------------------------------------------------------
// Scenario 10: Session recorded after affiliate redirect navigation
// ---------------------------------------------------------------------------

test('Scenario 10: CJ affiliate redirect records session for merchant root domain', async () => {
  await clearSessionManager();

  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-s10',
    'https://example.com/?smoke=10-merchant',
  ]);

  const page = await context.newPage();
  await page.goto(entryUrl);
  await page.close();

  const session = await waitForSession('https://example.com/?smoke=10-merchant');

  expect(session).not.toBeNull();
  expect(typeof session.detectedAt).toBe('number');
  expect(session.detectedAt).toBeGreaterThan(0);
  expect(session.result.hasAffiliatePattern).toBe(true);
  expect(
    session.result.matchedPatterns.some((m: { network: string }) => m.network === 'cj'),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 11: getAllSessions() returns a plain object with the expected key
// ---------------------------------------------------------------------------

test('Scenario 11: getAllSessions() contains expected root domain key after affiliate navigation', async () => {
  await clearSessionManager();

  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-s11',
    'https://example.com/?smoke=11-merchant',
  ]);

  const page = await context.newPage();
  await page.goto(entryUrl);
  await page.close();

  await waitForSession('https://example.com/?smoke=11-merchant');

  const allSessions = (await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).__sessionManager.getAllSessions();
  })) as Record<string, unknown>;

  expect('example.com' in allSessions).toBe(true);
  expect(typeof allSessions['example.com']).toBe('object');
});

// ---------------------------------------------------------------------------
// Scenario 12: getSession returns null for a never-visited domain
// ---------------------------------------------------------------------------

test('Scenario 12: getSession() returns null for domain with no affiliate session', async () => {
  await clearSessionManager();

  // Use a subdomain that won't be stripped; root domain is "not-affiliated.example.com"
  const session = await getSessionForUrl('https://not-affiliated.example.com/product');
  expect(session).toBeNull();
});

// ---------------------------------------------------------------------------
// Scenario 13: Second detection on same domain refreshes session record
// ---------------------------------------------------------------------------

test('Scenario 13: second affiliate detection on same domain overwrites session record', async () => {
  await clearSessionManager();

  // Directly exercise SessionManager.record() twice for the same domain.
  // This is the canonical way to test overwrite behavior without navigational timing concerns.
  await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sm = (globalThis as any).__sessionManager;
    sm.record(
      'https://example.com/?first',
      {
        hasAffiliatePattern: true,
        matchedPatterns: [{ network: 'cj', url: 'https://dpbolvw.net/first', rule: {} }],
        redirectChain: ['https://dpbolvw.net/first', 'https://example.com/?first'],
      },
      10,
    );
    sm.record(
      'https://example.com/?second',
      {
        hasAffiliatePattern: true,
        matchedPatterns: [{ network: 'cj', url: 'https://dpbolvw.net/second', rule: {} }],
        redirectChain: ['https://dpbolvw.net/second', 'https://example.com/?second'],
      },
      20,
    );
  });

  const session = await getSessionForUrl('https://example.com/any-page');
  expect(session).not.toBeNull();
  // Session should reflect the second record() call (tabId 20, second redirect chain)
  expect(session!.tabId).toBe(20);
  expect(
    session!.result.redirectChain.some((u: string) => u.includes('example.com/?second')),
  ).toBe(true);
  // First record should no longer be returned
  expect(
    session!.result.redirectChain.some((u: string) => u.includes('example.com/?first')),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Scenario 14-16 types and helper
// ---------------------------------------------------------------------------

interface SessionAwareStanddownResult {
  hasAffiliatePattern: boolean;
  matchedPatterns: Array<{ network: string; rule: unknown; url: string }>;
  redirectChain: string[];
  isOwnLink: boolean;
  shouldStanddown: boolean;
  reason: 'no_affiliate_detected' | 'own_link' | 'competitor_detected' | 'session_active';
  session: SessionRecord | null;
}

/**
 * Evaluate the full CHECK_STANDDOWN handler logic in the service worker
 * context for the tab whose URL contains `urlFragment`. Mirrors the message
 * handler's async session lookup so Playwright can assert on the complete
 * response shape without a message round-trip from a non-extension context.
 */
async function evalCheckStanddown(
  urlFragment: string,
): Promise<SessionAwareStanddownResult | null> {
  return sw.evaluate(async (fragment: string) => {
    // Locate the tab by URL fragment (poll up to 2 s).
    const deadline = Date.now() + 2000;
    let tabId: number | undefined;
    while (Date.now() < deadline) {
      const tabs: chrome.tabs.Tab[] = await new Promise((r) => chrome.tabs.query({}, r));
      const match = tabs.find((t) => t.url?.includes(fragment));
      if (match?.id != null) {
        tabId = match.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!tabId) return null;

    // Mirror CHECK_STANDDOWN handler logic (sync live result + async tab URL).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveResult = (globalThis as any).__checkStanddown(tabId) as SessionAwareStanddownResult;
    const tab: chrome.tabs.Tab = await new Promise((r) => chrome.tabs.get(tabId!, r));
    const tabUrl = tab?.url ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = tabUrl ? (globalThis as any).__sessionManager.getSession(tabUrl) : null;
    const sessionActive = session !== null && !liveResult.isOwnLink;
    const shouldStanddown = liveResult.shouldStanddown || sessionActive;
    const reason: SessionAwareStanddownResult['reason'] = liveResult.shouldStanddown
      ? liveResult.reason
      : sessionActive
        ? 'session_active'
        : liveResult.reason;
    return { ...liveResult, shouldStanddown, reason, session };
  }, urlFragment) as Promise<SessionAwareStanddownResult | null>;
}

// ---------------------------------------------------------------------------
// Scenario 14: session-based shouldStanddown on subsequent clean navigation
// ---------------------------------------------------------------------------

test('Scenario 14: clean navigation to affiliated domain returns shouldStanddown true via session', async () => {
  await clearSessionManager();

  // Step 1: Affiliate navigation through CJ redirect chain; establishes session.
  const affiliateEntry = await registerChain([
    'https://dpbolvw.net/click-s14',
    'https://example.com/?smoke=14-affiliate',
  ]);
  const page = await context.newPage();
  await page.goto(affiliateEntry);
  await waitForSession('https://example.com/?smoke=14-affiliate');

  // Step 2: Clean navigation on the same tab to the same domain (no affiliate redirect).
  await page.goto('https://example.com/?smoke=14-clean');

  // Step 3: Assert session-based stand-down; page is clean but session is active.
  const result = await evalCheckStanddown('smoke=14-clean');
  await page.close();

  expect(result).not.toBeNull();
  expect(result!.hasAffiliatePattern).toBe(false); // no affiliate on the current page
  expect(result!.shouldStanddown).toBe(true);       // but session makes us stand down
  expect(result!.reason).toBe('session_active');
  expect(result!.session).not.toBeNull();
  expect(result!.session!.result.hasAffiliatePattern).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 15: no session → session field is null, shouldStanddown false
// ---------------------------------------------------------------------------

test('Scenario 15: CHECK_STANDDOWN on domain with no prior session returns session null', async () => {
  await clearSessionManager();

  const page = await context.newPage();
  await page.goto('https://example.com/?smoke=15-clean');

  const result = await evalCheckStanddown('smoke=15-clean');
  await page.close();

  expect(result).not.toBeNull();
  expect(result!.session).toBeNull();
  expect(result!.shouldStanddown).toBe(false);
  expect(result!.reason).toBe('no_affiliate_detected');
});

// ---------------------------------------------------------------------------
// Scenario 16: own affiliate link + active session → shouldStanddown false
// ---------------------------------------------------------------------------

test('Scenario 16: own affiliate link suppresses shouldStanddown even when session is active', async () => {
  await clearSessionManager();

  // Establish a session for example.com from a prior affiliate navigation.
  const affiliateEntry = await registerChain([
    'https://dpbolvw.net/click-s16',
    'https://example.com/?smoke=16-setup',
  ]);
  const setupPage = await context.newPage();
  await setupPage.goto(affiliateEntry);
  await waitForSession('https://example.com/?smoke=16-setup');
  await setupPage.close();

  // Navigate to a page carrying this extension's own CJ publisher identifiers.
  // checkForAffiliatePatterns detects CJ, but isOwnAffiliateLink returns true,
  // so liveResult.shouldStanddown is already false; session must not override this.
  const page = await context.newPage();
  await page.goto(
    'https://example.com/?cjevent=smoke-16&m_pl=YourExtension&m_si=12345&smoke=16-own',
  );

  const result = await evalCheckStanddown('smoke=16-own');
  await page.close();

  expect(result).not.toBeNull();
  expect(result!.isOwnLink).toBe(true);
  expect(result!.shouldStanddown).toBe(false);
  expect(result!.reason).toBe('own_link');
});

// ---------------------------------------------------------------------------
// Popup Session-1: popup shows "Session active" after affiliate navigation
// ---------------------------------------------------------------------------

test('Popup Session-1: popup #session-status shows "Session active" when session exists for domain', async () => {
  await clearSessionManager();

  // Navigate through a CJ affiliate chain to establish a session for example.com.
  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-ps1',
    'https://example.com/?smoke=ps1-merchant',
  ]);
  const page = await context.newPage();
  await page.goto(entryUrl);
  await waitForSession('https://example.com/?smoke=ps1-merchant');

  const tabId = await getTabId('smoke=ps1-merchant');

  // Open the popup for this tab; it will send CHECK_STANDDOWN which now includes
  // the session field, and displaySessionState() will render the session status.
  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup/popup.html?tabId=${tabId}`);

  await expect(popup.locator('#session-status')).toHaveText('Session active');
  // Timestamp should be non-empty (set to detectedAt formatted as locale time).
  const timestampText = await popup.locator('#session-timestamp').textContent();
  expect(timestampText).not.toBe('');

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// Popup Session-2: popup shows "No session" when domain has no prior session
// ---------------------------------------------------------------------------

test('Popup Session-2: popup #session-status shows "No session" when no session exists for domain', async () => {
  await clearSessionManager();

  // Navigate to a clean page; no affiliate redirect, no session.
  const page = await context.newPage();
  await page.goto('https://example.com/?smoke=ps2-clean');

  const tabId = await getTabId('smoke=ps2-clean');

  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup/popup.html?tabId=${tabId}`);

  await expect(popup.locator('#session-status')).toHaveText('No session');
  await expect(popup.locator('#session-timestamp')).toHaveText('');

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// Scenario 17: session persists after affiliate tab is closed
// ---------------------------------------------------------------------------

test('Scenario 17: session remains active after the tab that established it is closed', async () => {
  await clearSessionManager();

  // Establish an affiliate session in a tab, then close that tab.
  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-s17',
    'https://example.com/?smoke=17-merchant',
  ]);
  const affiliateTab = await context.newPage();
  await affiliateTab.goto(entryUrl);
  const affiliateTabId = await getTabId('smoke=17-merchant');
  await waitForSession('https://example.com/?smoke=17-merchant');

  // Close the tab that triggered the session.
  await affiliateTab.close();

  // Session must still be retrievable by domain after tab closure.
  const session = await getSessionForUrl('https://example.com/any-page');
  expect(session).not.toBeNull();
  expect(session!.result.hasAffiliatePattern).toBe(true);

  // CHECK_STANDDOWN for the closed tab must still return session_active.
  const result = await sw.evaluate(async (tabId: number) => {
    return new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkFn = (globalThis as any).__checkStanddown as (id: number) => unknown;
      const liveResult = checkFn(tabId) as { shouldStanddown: boolean; isOwnLink: boolean; reason: string };
      // Mirror CHECK_STANDDOWN handler: fall back to __latestCallbackByTab for closed tab URL.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastEvent = (globalThis as any).__latestCallbackByTab?.get(tabId);
      const lastUrl = lastEvent?.result?.redirectChain?.at(-1) ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = lastUrl ? (globalThis as any).__sessionManager.getSession(lastUrl) : null;
      const sessionActive = session !== null && !liveResult.isOwnLink;
      resolve({
        shouldStanddown: liveResult.shouldStanddown || sessionActive,
        reason: sessionActive ? 'session_active' : liveResult.reason,
        session,
      });
    });
  }, affiliateTabId) as { shouldStanddown: boolean; reason: string; session: SessionRecord | null };

  expect(result.session).not.toBeNull();
  expect(result.shouldStanddown).toBe(true);
  expect(result.reason).toBe('session_active');
});

// ---------------------------------------------------------------------------
// Scenario WR-1: real 302 redirect chain captures intermediate hop
//
// Uses a local Node.js HTTP server that produces genuine 302 responses so
// Chrome processes the chain internally. This validates that onBeforeRequest
// captures intermediate hops that onBeforeNavigate would have missed.
//
// Chain: /wr1-a → 302 → /wr1-b?cjevent=wr1 → 302 → /wr1-c → 200
// The intermediate URL /wr1-b?cjevent=wr1 matches the embedded CJ
// params:"cjevent" rule.
// ---------------------------------------------------------------------------

test.describe('Scenario WR-1: real 302 redirect chain', () => {
  const WR1_PORT = 19876;
  let wr1Server: Server;

  test.beforeAll(async () => {
    wr1Server = await startLocalServer(WR1_PORT);
  });

  test.afterAll(async () => {
    await stopLocalServer(wr1Server);
  });

  test('real 302 redirect chain captures intermediate hop and detects CJ affiliate', async () => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${WR1_PORT}/wr1-a`, { waitUntil: 'commit' });
    // Allow time for navigation events to settle in the service worker.
    await page.waitForTimeout(500);

    const result = await checkTab(`127.0.0.1:${WR1_PORT}/wr1-c`);
    await page.close();

    expect(result.redirectChain.length).toBe(3);
    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns.some((m) => m.network === 'cj')).toBe(true);
    // The matched URL must be the intermediate hop containing ?cjevent=wr1.
    expect(result.matchedPatterns.some((m) => m.url.includes('cjevent=wr1'))).toBe(true);
  });
});
