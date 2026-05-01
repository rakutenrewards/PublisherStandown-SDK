/**
 * Redirect Chain Helper (Path A: Playwright context.route() interception)
 *
 * Provides a stable, test-facing API for registering multi-hop HTTP redirect
 * chains without exposing the underlying Playwright route interception mechanism
 * to test code.
 *
 * Usage:
 *   // In beforeAll, after service worker is ready:
 *   await setupRedirectChainHelper(context);
 *
 *   // In each test:
 *   const entryUrl = await registerChain([
 *     'https://dpbolvw.net/click-xxx',
 *     'https://example.com/?smoke=merchant',
 *   ]);
 *   await page.goto(entryUrl);
 */

import type { BrowserContext } from '@playwright/test';

/** Stored BrowserContext, set once in setupRedirectChainHelper, used by registerChain. */
let _context: BrowserContext | null = null;

/**
 * Initialises the redirect chain helper with the shared browser context.
 * Call once in `beforeAll` after the service worker is ready.
 *
 * Path A: stores the BrowserContext reference for use in registerChain.
 */
export async function setupRedirectChainHelper(context: BrowserContext): Promise<void> {
  _context = context;
}

/**
 * Registers an ordered redirect chain so that navigating to `urls[0]` produces
 * HTTP 302 → `urls[1]`, `urls[1]` → HTTP 302 → `urls[2]`, …, `urls[N-1]` → HTTP 200.
 *
 * Returns `urls[0]` as the navigation entry point.
 *
 * Handlers are one-shot; each fires exactly once and is then automatically
 * retired by Playwright (`{ times: 1 }`), preventing cross-test accumulation.
 *
 * @param urls Two or more full absolute URLs forming the redirect chain.
 * @returns    `urls[0]` -- navigate to this URL to trigger the chain.
 *
 * @throws {Error} If `setupRedirectChainHelper` has not been called first.
 * @throws {Error} If fewer than two URLs are provided.
 */
export async function registerChain(urls: string[]): Promise<string> {
  if (!_context) {
    throw new Error(
      'registerChain: call setupRedirectChainHelper(context) in beforeAll first',
    );
  }
  if (urls.length < 2) {
    throw new Error('registerChain: requires at least two URLs');
  }

  // Register one-shot route handlers for each hop in the chain.
  //
  // URL matching uses a function predicate, NOT a glob string, because
  // Playwright's glob engine treats '?' as a single-character wildcard, which
  // causes spurious matches or misses on affiliate URLs that contain query params.
  //
  // { times: 1 } causes Playwright to automatically retire each handler after
  // its first fulfillment, preventing handler accumulation across tests.

  for (let i = 0; i < urls.length - 1; i++) {
    const from = urls[i]!;
    const to = urls[i + 1]!;
    await _context.route(
      (url) => url.toString() === from,
      (route) => route.fulfill({ status: 302, headers: { Location: to } }),
      { times: 1 },
    );
  }

  // Terminal URL → HTTP 200 with minimal HTML body
  const terminal = urls[urls.length - 1]!;
  await _context.route(
    (url) => url.toString() === terminal,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );

  return urls[0]!;
}
