/**
 * StanddownSDK Firefox namespace resolution tests
 *
 * Exercises `resolveWebExtApi()` by controlling `globalThis.browser` in each
 * test. Verifies that the SDK prefers Firefox's `browser` namespace when it
 * exposes `webNavigation`, and falls back to stub-tracker mode otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StanddownSDK } from '../../src/api/index.js';
import type {
  BeforeRequestDetails,
  CommittedDetails,
} from '../../src/detection/tracker.js';
import { makeSpyEvent } from '../helpers/mock-events.js';

// ---------------------------------------------------------------------------
// Firefox namespace resolution tests
// ---------------------------------------------------------------------------

describe('StanddownSDK: Firefox browser namespace resolution', () => {
  afterEach(() => {
    // Restore globalThis.browser to its default absent state after each test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    try { delete (globalThis as any).browser; } catch { /* ignore non-configurable */ }
  });

  it('registers listeners on browser.* events when browser exposes webNavigation', () => {
    // Arrange: construct a minimal browser mock with spy addListeners
    const mockBrowser = {
      webNavigation: {
        onCommitted: makeSpyEvent<CommittedDetails>(),
      },
      webRequest: {
        onBeforeRequest: makeSpyEvent<BeforeRequestDetails>(),
      },
      tabs: {
        onRemoved: makeSpyEvent<number>(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (globalThis as any).browser = mockBrowser;

    // Act — no-policy warn fires because no policies are passed; suppress it.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new StanddownSDK();
    warnSpy.mockRestore();

    // Assert: TrackerDeps listeners wired to browser, not chrome
    expect(mockBrowser.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.webNavigation.onCommitted.addListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);

    // Assert: destroy() calls removeListener on the same browser namespace
    sdk.destroy();
    expect(mockBrowser.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.webNavigation.onCommitted.removeListener).toHaveBeenCalledTimes(1);
    expect(mockBrowser.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
  });

  it('falls back to stub-tracker mode when browser is present but has no webNavigation', () => {
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
});
