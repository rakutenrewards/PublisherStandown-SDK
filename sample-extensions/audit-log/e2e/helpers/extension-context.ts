import type { BrowserContext, Worker } from '@playwright/test';
import { chromium } from '@playwright/test';

export interface ExtensionContext {
  context: BrowserContext;
  sw: Worker;
  /** Full origin prefix: "chrome-extension://[id]" */
  extensionOrigin: string;
}

export async function launchExtensionContext(
  extensionPath: string,
): Promise<ExtensionContext> {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const workers = context.serviceWorkers();
  const sw = workers[0] ?? (await context.waitForEvent('serviceworker'));

  await sw.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const poll = () => {
        if ((globalThis as Record<string, unknown>)['__sdk']) resolve();
        else setTimeout(poll, 50);
      };
      poll();
    });
  });

  const originMatch = sw.url().match(/^((?:chrome|moz|safari-web)-extension:\/\/[^/]+)/);
  const extensionOrigin = originMatch?.[1] ?? '';

  return { context, sw, extensionOrigin };
}
