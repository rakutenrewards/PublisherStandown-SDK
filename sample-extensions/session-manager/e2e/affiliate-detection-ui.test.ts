/**
 * Affiliate Detection UI: E2E Tests
 *
 * Verifies that the popup UI changes introduced by the affiliate-detection-ui
 * feature are rendered correctly. Tests cover:
 *
 * - DOM structure: all new elements are present
 * - ON-DEMAND CHECK section: status, result pre, data attributes
 * - CALLBACK EVENT section: redirect chain URLs, matched pattern details,
 *   rule type display, timestamp, and empty state
 * - Rule type accuracy: "domain" for CJ redirect domain, "params" for afsrc
 * - Regression: existing data-hasAffiliatePattern / data-networkCount selectors
 *   still work (relied on by other tooling)
 */

import { test, expect } from '@playwright/test';
import type { BrowserContext, Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupRedirectChainHelper, registerChain } from './helpers/redirect-chain-helper.js';
import { launchExtensionContext } from './helpers/extension-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Shared browser context
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
// Helpers
// ---------------------------------------------------------------------------

/** Resolves the tabId for the tab whose URL contains the given fragment. */
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

/** Opens the extension popup for a specific tab and returns the page. */
async function openPopup(tabId: number) {
  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup/popup.html?tabId=${tabId}`);
  return popup;
}

// ---------------------------------------------------------------------------
// 1. DOM structure
// ---------------------------------------------------------------------------

test('UI structure: all expected elements are present in the popup', async () => {
  // Any tab will do; we just need the popup to load.
  const page = await context.newPage();
  await page.goto('https://example.com/?ui-struct=1');
  const tabId = await getTabId('ui-struct=1');

  const popup = await openPopup(tabId);

  // Section labels
  await expect(popup.locator('.section-label').first()).toBeVisible();

  // ON-DEMAND CHECK label and elements
  await expect(popup.locator('.section-label', { hasText: 'ON-DEMAND CHECK' })).toBeVisible();
  await expect(popup.locator('#status')).toBeVisible();
  await expect(popup.locator('#result')).toBeAttached();

  // Section dividers
  await expect(popup.locator('hr.section-divider').first()).toBeVisible();

  // DECISION label and elements
  await expect(popup.locator('.section-label', { hasText: 'DECISION' })).toBeVisible();
  await expect(popup.locator('#decision-status')).toBeAttached();
  await expect(popup.locator('#decision-reason')).toBeAttached();

  // SESSION label and elements
  await expect(popup.locator('.section-label', { hasText: 'SESSION' })).toBeVisible();
  await expect(popup.locator('#session-status')).toBeVisible();
  await expect(popup.locator('#session-detection')).toBeAttached();
  await expect(popup.locator('#session-tab')).toBeAttached();
  // redirect-chain and matched-patterns IDs live inside #session-detection
  await expect(popup.locator('#redirect-chain')).toBeAttached();
  await expect(popup.locator('#matched-patterns')).toBeAttached();

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 2. ON-DEMAND CHECK section
// ---------------------------------------------------------------------------

test('ON-DEMAND CHECK: shows affiliate pattern detected after CJ navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-od-1');
  const tabId = await getTabId('cjevent=ui-od-1');

  const popup = await openPopup(tabId);

  // Status banner
  await expect(popup.locator('#status')).toHaveClass(/match/);
  await expect(popup.locator('#status')).toContainText('Competitor affiliate detected');

  // Result pre block has data attributes for tooling
  await expect(popup.locator('#result')).toHaveAttribute('data-has-affiliate-pattern', 'true');
  const networkCount = await popup.locator('#result').getAttribute('data-network-count');
  expect(Number(networkCount)).toBeGreaterThan(0);

  await popup.close();
  await page.close();
});

test('ON-DEMAND CHECK: shows no affiliate pattern on clean navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?ui-od-clean=1');
  const tabId = await getTabId('ui-od-clean=1');

  const popup = await openPopup(tabId);

  await expect(popup.locator('#status')).toHaveClass(/clean/);
  await expect(popup.locator('#status')).toContainText('No affiliate pattern');
  await expect(popup.locator('#result')).toHaveAttribute('data-has-affiliate-pattern', 'false');
  await expect(popup.locator('#result')).toHaveAttribute('data-network-count', '0');

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 3. SESSION section: detail content when session is active
// ---------------------------------------------------------------------------

test('SESSION: redirect chain and matched patterns are visible when session is active', async () => {
  await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__sessionManager.clear();
  });

  const entryUrl = await registerChain([
    'https://dpbolvw.net/click-ui-session-chain',
    'https://example.com/?ui-session-chain-merchant',
  ]);
  const page = await context.newPage();
  await page.goto(entryUrl);

  // Wait for session to be recorded before opening popup.
  await sw.evaluate(async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (globalThis as any).__sessionManager.getSession('https://example.com/');
      if (s !== null) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Session not recorded within timeout');
  });

  const tabId = await getTabId('ui-session-chain-merchant');
  const popup = await openPopup(tabId);

  // #session-detection block must be visible when session is active.
  await expect(popup.locator('#session-detection')).toBeVisible();

  // Redirect chain must contain the CJ click domain.
  const items = popup.locator('#redirect-chain li');
  expect(await items.count()).toBeGreaterThan(0);
  const chainText = await items.allTextContents();
  expect(chainText.some((t) => t.includes('dpbolvw.net'))).toBe(true);

  // Match entry must show CJ network, affiliate URL, and domain rule type.
  await expect(popup.locator('.match-network').first()).toContainText('cj');
  await expect(popup.locator('.match-url').first()).toContainText('dpbolvw.net');
  await expect(popup.locator('.match-rule').first()).toHaveText('Rule: domain');

  await popup.close();
  await page.close();
});

test('SESSION: tab indicator shows the tabId that created the session', async () => {
  await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__sessionManager.clear();
  });

  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-session-tab-1');
  const tabId = await getTabId('cjevent=ui-session-tab-1');

  // Wait for session.
  await sw.evaluate(async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (globalThis as any).__sessionManager.getSession('https://example.com/');
      if (s !== null) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Session not recorded within timeout');
  });

  const popup = await openPopup(tabId);

  // Tab indicator must reference the navigating tab.
  const tabText = await popup.locator('#session-tab').textContent();
  expect(tabText).toContain(String(tabId));

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 4. expiresAt in DetectionResult (EPIC2-004)
// ---------------------------------------------------------------------------

test('expiresAt: is a number in the detection result after an affiliate navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-expires-1');
  const tabId = await getTabId('cjevent=ui-expires-1');

  const popup = await openPopup(tabId);

  // The #result pre contains the JSON-serialised DetectionResult.
  const resultText = await popup.locator('#result').textContent();
  const result = JSON.parse(resultText ?? '{}') as { expiresAt: unknown };
  expect(typeof result.expiresAt).toBe('number');
  expect(result.expiresAt as number).toBeGreaterThan(Date.now());

  await popup.close();
  await page.close();
});

test('expiresAt: is null in the detection result after a clean navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?ui-expires-clean=1');
  const tabId = await getTabId('ui-expires-clean=1');

  const popup = await openPopup(tabId);

  const resultText = await popup.locator('#result').textContent();
  const result = JSON.parse(resultText ?? '{}') as { expiresAt: unknown };
  expect(result.expiresAt).toBeNull();

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 9. detectedAt in DetectionResult
// ---------------------------------------------------------------------------

test('detectedAt: is a number in the detection result after an affiliate navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-detected-1');
  const tabId = await getTabId('cjevent=ui-detected-1');

  const popup = await openPopup(tabId);

  const resultText = await popup.locator('#result').textContent();
  const result = JSON.parse(resultText ?? '{}') as { detectedAt: unknown };
  expect(typeof result.detectedAt).toBe('number');
  expect(result.detectedAt as number).toBeGreaterThan(0);

  await popup.close();
  await page.close();
});

test('detectedAt: is null in the detection result after a clean navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?ui-detected-clean=1');
  const tabId = await getTabId('ui-detected-clean=1');

  const popup = await openPopup(tabId);

  const resultText = await popup.locator('#result').textContent();
  const result = JSON.parse(resultText ?? '{}') as { detectedAt: unknown };
  expect(result.detectedAt).toBeNull();

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 9. Session expiry display in popup (EPIC2-004)
// ---------------------------------------------------------------------------

test('Session display: shows "Expires: HH:MM:SS" in session timestamp when session is active', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-session-expires-1');
  const tabId = await getTabId('cjevent=ui-session-expires-1');
  // Wait for the session to be recorded before opening the popup.
  await sw.evaluate(async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (globalThis as any).__sessionManager.getSession('https://example.com/');
      if (s !== null) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Session not recorded within timeout');
  });

  const popup = await openPopup(tabId);

  await expect(popup.locator('#session-status')).toHaveText('Session active');
  const timestampText = await popup.locator('#session-timestamp').textContent();
  // Must start with "Expires: " followed by a time string
  expect(timestampText?.startsWith('Expires: ')).toBe(true);
  expect((timestampText ?? '').length).toBeGreaterThan('Expires: '.length);

  await popup.close();
  await page.close();
});

test('Session display: shows "No session" when session has expired', async () => {
  // Navigate to a real domain first so we have a valid tab at a known URL.
  const page = await context.newPage();
  await page.goto('https://example.com/?ui-expired=1');
  const tabId = await getTabId('ui-expired=1');

  // Clear any existing sessions, then inject one for example.com with a past expiresAt
  // via the public record() API (avoids accessing the private #sessions field).
  await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sm = (globalThis as any).__sessionManager;
    sm.clear();
    sm.record(
      'https://example.com/',
      {
        hasAffiliatePattern: true,
        matchedPatterns: [],
        redirectChain: ['https://example.com/'],
        expiresAt: Date.now() - 1000, // already expired
      },
      999,
    );
  });

  const popup = await openPopup(tabId);

  // getSession() prunes the expired entry; popup must show "No session"
  await expect(popup.locator('#session-status')).toHaveText('No session');
  await expect(popup.locator('#session-timestamp')).toHaveText('');

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 10. Data attribute regression
// ---------------------------------------------------------------------------

test('Regression: data-hasAffiliatePattern and data-networkCount attributes are present and correct', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-regression-1');
  const tabId = await getTabId('cjevent=ui-regression-1');

  const popup = await openPopup(tabId);

  // These attributes are relied on by external tooling; must not regress.
  await expect(popup.locator('#result')).toHaveAttribute('data-has-affiliate-pattern', 'true');
  const networkCount = await popup.locator('#result').getAttribute('data-network-count');
  expect(Number(networkCount)).toBeGreaterThanOrEqual(1);

  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// 11. DECISION section
// ---------------------------------------------------------------------------

test('DECISION: shows "Stand down" with reason "competitor_detected" after competitor affiliate navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-decision-competitor-1');
  const tabId = await getTabId('cjevent=ui-decision-competitor-1');
  const popup = await openPopup(tabId);

  await expect(popup.locator('#decision-status')).toHaveClass(/standdown/);
  await expect(popup.locator('#decision-status')).toHaveText('Stand down');
  await expect(popup.locator('#decision-reason')).toHaveText('competitor_detected');

  await popup.close();
  await page.close();
});

test('DECISION: shows "No stand-down" with reason "own_link" after own-affiliate navigation', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-decision-own-1&m_pl=YourExtension&m_si=12345');
  const tabId = await getTabId('cjevent=ui-decision-own-1');
  const popup = await openPopup(tabId);

  await expect(popup.locator('#decision-status')).toHaveClass(/no-standdown/);
  await expect(popup.locator('#decision-status')).toHaveText('No stand-down');
  await expect(popup.locator('#decision-reason')).toHaveText('own_link');

  await popup.close();
  await page.close();
});

test('DECISION: shows "No stand-down" with reason "no_affiliate_detected" after clean navigation', async () => {
  // Clear sessions so a prior example.com session doesn't trigger session-based stand-down.
  await sw.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__sessionManager.clear();
  });

  const page = await context.newPage();
  await page.goto('https://example.com/?ui-decision-clean=1');
  const tabId = await getTabId('ui-decision-clean=1');
  const popup = await openPopup(tabId);

  await expect(popup.locator('#decision-status')).toHaveClass(/no-standdown/);
  await expect(popup.locator('#decision-status')).toHaveText('No stand-down');
  await expect(popup.locator('#decision-reason')).toHaveText('no_affiliate_detected');

  await popup.close();
  await page.close();
});

test('#result JSON contains only SDK DetectionResult fields (no service-worker-only fields)', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?cjevent=ui-json-purity-1');
  const tabId = await getTabId('cjevent=ui-json-purity-1');
  const popup = await openPopup(tabId);

  const resultText = await popup.locator('#result').textContent();
  const parsed = JSON.parse(resultText ?? '{}') as Record<string, unknown>;

  // Service-worker-only fields must not appear in the SDK result display
  expect('isOwnLink' in parsed).toBe(false);
  expect('shouldStanddown' in parsed).toBe(false);
  expect('reason' in parsed).toBe(false);
  expect('session' in parsed).toBe(false);

  // All 6 SDK DetectionResult fields must be present
  expect('hasAffiliatePattern' in parsed).toBe(true);
  expect('matchedPatterns' in parsed).toBe(true);
  expect('redirectChain' in parsed).toBe(true);
  expect('detectedAt' in parsed).toBe(true);
  expect('expiresAt' in parsed).toBe(true);
  expect('isOwnAffiliateLink' in parsed).toBe(true);

  await popup.close();
  await page.close();
});

test('UI structure: DECISION section elements are present in the popup', async () => {
  const page = await context.newPage();
  await page.goto('https://example.com/?ui-struct-decision=1');
  const tabId = await getTabId('ui-struct-decision=1');
  const popup = await openPopup(tabId);

  await expect(popup.locator('.section-label', { hasText: 'DECISION' })).toBeVisible();
  await expect(popup.locator('#decision-status')).toBeAttached();
  await expect(popup.locator('#decision-reason')).toBeAttached();

  await popup.close();
  await page.close();
});
