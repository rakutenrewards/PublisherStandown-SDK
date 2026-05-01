/**
 * Redirect Chain Helper: audit-log extension
 *
 * Thin re-export of the redirect chain helper from session-manager.
 * Kept as a separate file so each extension's e2e folder is self-contained.
 */

import type { BrowserContext } from '@playwright/test';

let _context: BrowserContext | null = null;

export async function setupRedirectChainHelper(context: BrowserContext): Promise<void> {
  _context = context;
}

export async function registerChain(urls: string[]): Promise<string> {
  if (!_context) {
    throw new Error('registerChain: call setupRedirectChainHelper(context) in beforeAll first');
  }
  if (urls.length < 2) {
    throw new Error('registerChain: requires at least two URLs');
  }

  for (let i = 0; i < urls.length - 1; i++) {
    const from = urls[i]!;
    const to = urls[i + 1]!;
    await _context.route(
      (url) => url.toString() === from,
      (route) => route.fulfill({ status: 302, headers: { Location: to } }),
      { times: 1 },
    );
  }

  const terminal = urls[urls.length - 1]!;
  await _context.route(
    (url) => url.toString() === terminal,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
    { times: 1 },
  );

  return urls[0]!;
}
