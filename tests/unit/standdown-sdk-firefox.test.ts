/**
 * StanddownSDK Firefox / Safari namespace resolution tests
 *
 * Exercises `resolveWebExtApi()` and per-browser dep selection by controlling
 * `globalThis.browser` and `globalThis.navigator` in each test. Verifies that:
 * - Chrome/Firefox/Edge use headers mode (webRequest.onHeadersReceived) and
 *   never touch webNavigation (so the permission is optional there).
 * - Safari (navigator.vendor) uses navigation-only mode (webNavigation).
 * - Missing/broken namespaces fall back to stub-tracker mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StanddownSDK } from '../../src/api/index.js';
import type {
  BeforeNavigateDetails,
  CommittedDetails,
  HeadersReceivedDetails,
} from '../../src/detection/tracker.js';
import { makeSpyEvent } from '../helpers/mock-events.js';

// ---------------------------------------------------------------------------
// Namespace resolution + per-browser mode selection
// ---------------------------------------------------------------------------

describe('StanddownSDK: browser namespace resolution', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    try { delete (globalThis as any).browser; } catch { /* ignore non-configurable */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    try { delete (globalThis as any).navigator; } catch { /* ignore non-configurable */ }
  });

  it('headers mode: registers webRequest.onHeadersReceived on browser.* and never touches webNavigation (Firefox)', () => {
    // Firefox exposes the API as `browser`. Non-Apple vendor → headers mode.
    const mockBrowser = {
      webRequest: {
        onHeadersReceived: makeSpyEvent<HeadersReceivedDetails>(),
      },
      // Present but must NOT be registered on non-Safari — webNavigation is optional here.
      webNavigation: {
        onBeforeNavigate: makeSpyEvent<BeforeNavigateDetails>(),
        onCommitted: makeSpyEvent<CommittedDetails>(),
      },
      tabs: {
        onRemoved: makeSpyEvent<number>(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).browser = mockBrowser;
    Object.defineProperty(globalThis, 'navigator', { value: { vendor: 'Google Inc.' }, configurable: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new StanddownSDK();
    warnSpy.mockRestore();

    // headers mode wired to browser.*, not chrome
    expect(mockBrowser.webRequest.onHeadersReceived.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    // webNavigation is untouched on non-Safari
    expect(mockBrowser.webNavigation.onBeforeNavigate.addListener).not.toHaveBeenCalled();
    expect(mockBrowser.webNavigation.onCommitted.addListener).not.toHaveBeenCalled();

    // destroy() removes listeners from the same browser namespace
    sdk.destroy();
    expect(mockBrowser.webRequest.onHeadersReceived.removeListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
  });

  it('resolves headers mode when browser exposes only webRequest (no webNavigation declared)', () => {
    // Chrome/Firefox/Edge build that omits the optional webNavigation permission.
    const mockBrowser = {
      webRequest: { onHeadersReceived: makeSpyEvent<HeadersReceivedDetails>() },
      tabs: { onRemoved: makeSpyEvent<number>() },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).browser = mockBrowser;
    Object.defineProperty(globalThis, 'navigator', { value: { vendor: 'Google Inc.' }, configurable: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new StanddownSDK();
    warnSpy.mockRestore();

    expect(mockBrowser.webRequest.onHeadersReceived.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    sdk.destroy();
  });

  it('falls back to stub-tracker mode when browser is present but exposes neither webRequest nor webNavigation', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).browser = { someOtherApi: {} };
    // chrome is not defined in Node.js → tryBuildDeps() returns null → stub mode
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sdk = new StanddownSDK();
    const result = sdk.checkForAffiliatePatterns(1);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
    warnSpy.mockRestore();
  });

  it('falls back to stub-tracker mode when browser throws on access', () => {
    Object.defineProperty(globalThis, 'browser', {
      get() { throw new Error('browser access denied'); },
      configurable: true,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sdk = new StanddownSDK();
    const result = sdk.checkForAffiliatePatterns(1);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
    warnSpy.mockRestore();
  });

  it('falls back to stub-tracker mode when browser is undefined (Chrome/Node path)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).browser = undefined;
    // chrome is not defined in Node.js → tryBuildDeps() returns null → stub mode
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sdk = new StanddownSDK();
    const result = sdk.checkForAffiliatePatterns(1);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
    warnSpy.mockRestore();
  });

  it('uses navigation-only mode on Safari (navigator.vendor = "Apple Computer, Inc.")', () => {
    // Simulates Safari: webRequest stubs are callable but silently drop listeners.
    // The SDK detects Safari via navigator.vendor and uses webNavigation instead.
    const mockBrowser = {
      webNavigation: {
        onBeforeNavigate: makeSpyEvent<BeforeNavigateDetails>(),
        onCommitted: makeSpyEvent<CommittedDetails>(),
      },
      webRequest: {
        // Callable stub — same shape as real Safari; must NOT be registered.
        onHeadersReceived: makeSpyEvent<HeadersReceivedDetails>(),
      },
      tabs: {
        onRemoved: makeSpyEvent<number>(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).browser = mockBrowser;
    // Node/Vitest has no navigator global; define one for this test.
    Object.defineProperty(globalThis, 'navigator', { value: { vendor: 'Apple Computer, Inc.' }, configurable: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new StanddownSDK();
    warnSpy.mockRestore();

    // onBeforeNavigate and onCommitted must be registered; onHeadersReceived must not
    expect(mockBrowser.webNavigation.onBeforeNavigate.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.webNavigation.onCommitted.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.webRequest.onHeadersReceived.addListener).not.toHaveBeenCalled();

    sdk.destroy();
    expect(mockBrowser.webNavigation.onBeforeNavigate.removeListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.webNavigation.onCommitted.removeListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
  });
});
