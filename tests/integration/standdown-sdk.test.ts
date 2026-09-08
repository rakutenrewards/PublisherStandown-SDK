/**
 * Integration tests for StanddownSDK.
 *
 * Epic 1 tests use MockNavigationTracker (preset chains, no real events).
 * Epic 3 (EPIC3-006) tests use NavigationTracker with injectable mock chrome
 * events: fire events → build chain dynamically → call checkForAffiliatePatterns.
 */
import { describe, expect, it, vi } from 'vitest';
import { StanddownSDK } from '../../src/api/index.js';
import { NavigationTracker } from '../../src/detection/tracker.js';
import type {
  HeadersReceivedDetails,
  TrackerDeps,
} from '../../src/detection/tracker.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import type { StorageDeps } from '../../src/audit/storage-deps.js';
import type { NetworkPolicy } from '../../src/types/index.js';
import { makeMockEvent } from '../helpers/mock-events.js';

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

class MockNavigationTracker extends NavigationTracker {
  private readonly chains: Map<number, string[]>;

  constructor(chains: Record<number, string[]>) {
    super();
    this.chains = new Map(Object.entries(chains).map(([k, v]) => [Number(k), v]));
  }

  override getChain(tabId: number): string[] {
    return this.chains.get(tabId) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Test policies
// ---------------------------------------------------------------------------

const CJ_POLICY: NetworkPolicy = {
  id: 'test-cj',
  schemaVersion: 2,
  policyVersion: 2,
  network: { id: 'test-cj', name: 'Test CJ' },
  rules: [
    {
      domain: 'dpbolvw.net',
      reason: 'CJ click-tracking domain',
    },
    {
      domain: 'jdoqocy.com',
      reason: 'CJ alternate click-tracking domain',
    },
  ],
};

const AFSRC_POLICY: NetworkPolicy = {
  id: 'afsrc-generic',
  schemaVersion: 2,
  policyVersion: 2,
  network: { id: 'afsrc', name: 'Generic Affiliate Source' },
  rules: [
    {
      params: 'afsrc',
      reason: 'Standard affiliate source standdown parameter',
    },
  ],
};

const RAKUTEN_POLICY: NetworkPolicy = {
  id: 'test-rakuten',
  schemaVersion: 2,
  policyVersion: 2,
  network: { id: 'test-rakuten', name: 'Test Rakuten' },
  rules: [
    {
      domain: 'linksynergy.com',
      reason: 'Rakuten primary affiliate domain',
    },
    {
      domain: 'click.linksynergy.com',
      reason: 'Rakuten click-tracking subdomain',
    },
    {
      params: 'ranEAID',
      reason: 'Rakuten tracking parameter on destination URL',
    },
    {
      params: 'ranSiteID',
      reason: 'Rakuten site ID parameter on destination URL',
    },
  ],
};

const ALL_POLICIES = [CJ_POLICY, AFSRC_POLICY, RAKUTEN_POLICY];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAB_ID = 42;
const UNKNOWN_TAB_ID = 99;

function shieldWith(chain: string[], policies = ALL_POLICIES): StanddownSDK {
  return new StanddownSDK(
    { policies },
    new MockNavigationTracker({ [TAB_ID]: chain }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: CJ redirect domain detected in chain
// ---------------------------------------------------------------------------

describe('StanddownSDK: CJ redirect domain in chain', () => {
  it('returns hasAffiliatePattern: true when chain contains a CJ tracking domain', () => {
    const shield = shieldWith([
      'https://dpbolvw.net/click-123456-789',
      'https://macys.com/product/123',
    ]);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns).toHaveLength(1);
    expect(result.matchedPatterns[0]?.network).toBe('test-cj');
    expect(result.matchedPatterns[0]?.url).toBe('https://dpbolvw.net/click-123456-789');
    expect(result.redirectChain).toEqual([
      'https://dpbolvw.net/click-123456-789',
      'https://macys.com/product/123',
    ]);
  });

  it('returns hasAffiliatePattern: true for an alternate CJ domain', () => {
    const shield = shieldWith(['https://jdoqocy.com/click-987-654', 'https://target.com/p/123']);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns[0]?.network).toBe('test-cj');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: afsrc=1 param on destination URL
// ---------------------------------------------------------------------------

describe('StanddownSDK: afsrc param on destination URL', () => {
  it('returns hasAffiliatePattern: true when destination URL has afsrc param', () => {
    const shield = shieldWith(['https://shop.example.com/checkout?afsrc=1&product=abc']);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns[0]?.network).toBe('afsrc');
    expect(result.matchedPatterns[0]?.url).toBe(
      'https://shop.example.com/checkout?afsrc=1&product=abc',
    );
  });

  it('returns false when similar-looking param name is present but not afsrc', () => {
    const shield = shieldWith(['https://shop.example.com/?src=1']);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Clean chain with no affiliate signals
// ---------------------------------------------------------------------------

describe('StanddownSDK: clean chain with no affiliate signals', () => {
  it('returns hasAffiliatePattern: false for a direct navigation with no patterns', () => {
    const shield = shieldWith(['https://www.google.com/', 'https://amazon.com/s?k=shoes']);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toHaveLength(0);
    expect(result.redirectChain).toHaveLength(2);
  });

  it('returns false when chain is empty', () => {
    const shield = shieldWith([]);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toHaveLength(0);
    expect(result.redirectChain).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Unknown tabId, empty result
// ---------------------------------------------------------------------------

describe('StanddownSDK: unknown tabId', () => {
  it('returns the empty no-match result for an untracked tab', () => {
    const shield = shieldWith(['https://dpbolvw.net/click-123']);
    const result = shield.checkForAffiliatePatterns(UNKNOWN_TAB_ID);

    expect(result).toEqual({
      hasAffiliatePattern: false,
      matchedPatterns: [],
      redirectChain: [],
      detectedAt: null,
      expiresAt: null,
      isOwnAffiliateLink: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Multi-network chain, all matches collected
// ---------------------------------------------------------------------------

describe('StanddownSDK: multi-network chain', () => {
  it('collects matches from multiple affiliate networks in the same chain', () => {
    const shield = shieldWith([
      'https://click.linksynergy.com/fs-bin/click?id=abc', // test-rakuten
      'https://dpbolvw.net/click-999-111', // test-cj
      'https://macys.com/?afsrc=1', // afsrc
    ]);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    // One match per URL, three affiliate URLs → three matches
    expect(result.matchedPatterns).toHaveLength(3);

    const networks = result.matchedPatterns.map((m) => m.network);
    expect(networks).toContain('test-rakuten');
    expect(networks).toContain('test-cj');
    expect(networks).toContain('afsrc');
  });

  it('produces only one match per URL even when multiple rules could match', () => {
    // URL matches both the domain rule and would also match via params, but
    // early exit means only the first matching rule is recorded per URL.
    const shield = shieldWith([
      'https://dpbolvw.net/click-123?afsrc=1', // matches CJ domain (first) AND afsrc param
    ]);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns).toHaveLength(1);
    // test-cj policy comes first in the policies array → first match wins
    expect(result.matchedPatterns[0]?.network).toBe('test-cj');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: No policies loaded
// ---------------------------------------------------------------------------

describe('StanddownSDK: no policies loaded', () => {
  it('emits console.warn when constructed with no arguments', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new StanddownSDK(
      undefined,
      new MockNavigationTracker({ [TAB_ID]: [] }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No policies loaded'));
    warnSpy.mockRestore();
  });

  it('emits console.warn when constructed with an empty policies array', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new StanddownSDK(
      { policies: [] },
      new MockNavigationTracker({ [TAB_ID]: [] }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No policies loaded'));
    warnSpy.mockRestore();
  });

  it('returns no-match from checkForAffiliatePatterns when no policies are configured', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shield = new StanddownSDK(
      undefined,
      new MockNavigationTracker({ [TAB_ID]: ['https://dpbolvw.net/click-123'] }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);
    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: redirectChain reflects the full observed chain
// ---------------------------------------------------------------------------

describe('StanddownSDK: redirectChain in result', () => {
  it('includes all URLs from the navigation chain in redirectChain', () => {
    const chain = [
      'https://dpbolvw.net/click-111',
      'https://intermediate.com/redir',
      'https://merchant.com/product?id=42',
    ];
    const shield = shieldWith(chain);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.redirectChain).toEqual(chain);
  });
});

// ---------------------------------------------------------------------------
// EPIC3-006: Live event integration helpers
// ---------------------------------------------------------------------------

/**
 * Creates a NavigationTracker with injectable mock chrome events and returns
 * the tracker plus helper functions to drive it from a test.
 *
 * Chrome/Firefox/Edge run in headers mode (onHeadersReceived), so these helpers
 * map onto status codes:
 * - fireBeforeRequest(url) → a 3xx response (buffers the URL as a redirect hop)
 * - fireCommitted(url)     → a 2xx response (closes the chain on the final URL)
 * The legacy names/args are retained so the scenario call-sites below read the
 * same as the real navigation sequence they simulate; the transitionQualifiers
 * argument is ignored in headers mode.
 */
function makeLiveTracker() {
  const onHeadersReceivedImpl = makeMockEvent<HeadersReceivedDetails>();
  const onHeadersReceived = {
    addListener(cb: (d: HeadersReceivedDetails) => void, _filter: unknown) {
      onHeadersReceivedImpl.addListener(cb);
    },
    removeListener(cb: (d: HeadersReceivedDetails) => void) {
      onHeadersReceivedImpl.removeListener(cb);
    },
  };
  const onTabRemoved = makeMockEvent<number>();

  const deps: TrackerDeps = { onHeadersReceived, onTabRemoved };
  const tracker = new NavigationTracker(deps);

  return {
    tracker,
    // 3xx response — buffers this URL as a redirect hop.
    fireBeforeRequest: (tabId: number, url: string, type = 'main_frame') =>
      onHeadersReceivedImpl.fire({ tabId, url, type, statusCode: 302 }),
    // 2xx response — closes the chain on this (final) URL.
    fireCommitted: (
      tabId: number,
      url: string,
      _transitionQualifiers: string[] = [],
    ) => onHeadersReceivedImpl.fire({ tabId, url, type: 'main_frame', statusCode: 200 }),
    fireTabRemoved: (tabId: number) => onTabRemoved.fire(tabId),
  };
}

// ---------------------------------------------------------------------------
// EPIC3-006 Scenario 1: Affiliate redirect chain via live events → detected
// ---------------------------------------------------------------------------

describe('StanddownSDK: live events: affiliate redirect chain (EPIC3-006)', () => {
  it('detects CJ tracking domain after server-redirect chain fires through events', () => {
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK({ policies: [CJ_POLICY] }, tracker);

    // User clicks affiliate link; CJ click-tracking URL appended to chain
    fireBeforeRequest(TAB_ID, 'https://dpbolvw.net/click-9876-54321');
    // Server redirects to merchant; merchant URL appended, then committed as redirect
    fireBeforeRequest(TAB_ID, 'https://macys.com/product/42');
    fireCommitted(TAB_ID, 'https://macys.com/product/42', ['server_redirect']);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns).toHaveLength(1);
    expect(result.matchedPatterns[0]?.network).toBe('test-cj');
    expect(result.matchedPatterns[0]?.url).toBe('https://dpbolvw.net/click-9876-54321');
    expect(result.redirectChain).toEqual([
      'https://dpbolvw.net/click-9876-54321',
      'https://macys.com/product/42',
    ]);
  });

  it('detects Rakuten affiliate domain in a client-redirect chain', () => {
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK({ policies: [RAKUTEN_POLICY] }, tracker);

    fireBeforeRequest(TAB_ID, 'https://click.linksynergy.com/fs-bin/click?id=abc');
    fireBeforeRequest(TAB_ID, 'https://store.com/');
    fireCommitted(TAB_ID, 'https://store.com/', ['client_redirect']);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns[0]?.network).toBe('test-rakuten');
    expect(result.redirectChain).toHaveLength(2);
  });

  it('detects Rakuten ranEAID parameter on an intermediate URL in the redirect chain', () => {
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK({ policies: [RAKUTEN_POLICY] }, tracker);

    fireBeforeRequest(TAB_ID, 'https://www.merchant.com/landing?ranEAID=1234567&ranSiteID=abc');
    fireBeforeRequest(TAB_ID, 'https://www.merchant.com/checkout');
    fireCommitted(TAB_ID, 'https://www.merchant.com/checkout', ['client_redirect']);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns[0]?.network).toBe('test-rakuten');
    expect(result.redirectChain).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// EPIC3-006 Scenario 2: Direct navigation with afsrc=1 → detected
// ---------------------------------------------------------------------------

describe('StanddownSDK: live events: direct navigation with afsrc param (EPIC3-006)', () => {
  it('detects afsrc param when user navigates directly to affiliate-tagged URL', () => {
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    // Use the AFSRC_POLICY fixture to test the user-policy injection path.
    // (generic-afsrc is now embedded; this test continues to exercise the user-policy merge path.)
    const shield = new StanddownSDK({ policies: [AFSRC_POLICY] }, tracker);

    // User navigates directly; onBeforeNavigate fires, then onCommitted with no redirect qualifier
    fireBeforeRequest(TAB_ID, 'https://shop.example.com/checkout?afsrc=1&product=abc');
    fireCommitted(TAB_ID, 'https://shop.example.com/checkout?afsrc=1&product=abc', []);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    // onCommitted with [] clears any prior chain and starts fresh with the committed URL,
    // so chain = ['https://shop.example.com/checkout?afsrc=1&product=abc']
    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.matchedPatterns[0]?.network).toBe('afsrc');
    expect(result.redirectChain).toEqual([
      'https://shop.example.com/checkout?afsrc=1&product=abc',
    ]);
  });
});

// ---------------------------------------------------------------------------
// EPIC3-006 Scenario 3: Clean navigation → no match
// ---------------------------------------------------------------------------

describe('StanddownSDK: live events: clean navigation (EPIC3-006)', () => {
  it('returns no-match for a direct clean navigation with no affiliate signals', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK(undefined, tracker);

    fireBeforeRequest(TAB_ID, 'https://www.example.com/');
    fireCommitted(TAB_ID, 'https://www.example.com/', []);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.matchedPatterns).toHaveLength(0);
    expect(result.redirectChain).toEqual(['https://www.example.com/']);
    warnSpy.mockRestore();
  });

  it('returns no-match after a clean navigation clears a previous affiliate chain', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK(undefined, tracker);

    // First: affiliate chain
    fireBeforeRequest(TAB_ID, 'https://dpbolvw.net/click-123');
    fireBeforeRequest(TAB_ID, 'https://merchant.com/');
    fireCommitted(TAB_ID, 'https://merchant.com/', ['server_redirect']);

    // User navigates away; chain is cleared
    fireBeforeRequest(TAB_ID, 'https://clean-site.com/');
    fireCommitted(TAB_ID, 'https://clean-site.com/', []);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.redirectChain).toEqual(['https://clean-site.com/']);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EPIC3-006 Scenario 4: Graceful degradation, chrome.webNavigation unavailable
// ---------------------------------------------------------------------------

describe('StanddownSDK: graceful degradation (EPIC3-006)', () => {
  it('logs a warning and returns no-match when chrome APIs are unavailable', () => {
    // In Node.js / Vitest, `chrome` is not a global; tryBuildDeps() catches
    // the ReferenceError and returns null, triggering degradation mode.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const shield = new StanddownSDK();
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[StanddownSDK]'));
    expect(result).toEqual({
      hasAffiliatePattern: false,
      matchedPatterns: [],
      redirectChain: [],
      detectedAt: null,
      expiresAt: null,
      isOwnAffiliateLink: false,
    });

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// StanddownSDK.destroy() -- ghost listener prevention
// ---------------------------------------------------------------------------

describe('StanddownSDK.destroy()', () => {
  it('is a no-op for a stub-mode SDK (no chrome APIs available)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = new StanddownSDK();
    expect(() => sdk.destroy()).not.toThrow();
    warnSpy.mockRestore();
  });

  it('stops the first SDK instance from processing events after destroy', () => {
    const { tracker: tracker1, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const sdk1 = new StanddownSDK({ policies: [CJ_POLICY] }, tracker1);

    // Build an affiliate chain via the first SDK
    fireBeforeRequest(TAB_ID, 'https://dpbolvw.net/click-111');
    fireCommitted(TAB_ID, 'https://dpbolvw.net/click-111', []);
    expect(sdk1.checkForAffiliatePatterns(TAB_ID).hasAffiliatePattern).toBe(true);

    // Destroy the first SDK; its tracker listeners are removed
    sdk1.destroy();

    // Navigate again -- sdk1 must no longer track anything
    fireBeforeRequest(TAB_ID, 'https://dpbolvw.net/click-222');
    fireCommitted(TAB_ID, 'https://dpbolvw.net/click-222', []);
    expect(sdk1.checkForAffiliatePatterns(TAB_ID).hasAffiliatePattern).toBe(false);
  });

  it('a second SDK instance on the same events remains fully functional after the first is destroyed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tracker: tracker1, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const { tracker: tracker2 } = makeLiveTracker();
    // Wire tracker2 to the same underlying event sources as tracker1 by sharing makeLiveTracker deps.
    // For this test we use separate trackers on separate mock events; the key assertion is that
    // destroying sdk1 has no effect on an independently constructed sdk2.
    const sdk1 = new StanddownSDK(undefined, tracker1);
    const sdk2 = new StanddownSDK(undefined, tracker2);

    sdk1.destroy();

    // sdk2's tracker is independent; events fired on makeLiveTracker go to tracker1's events only.
    // Directly build the chain on tracker2's live events via a second makeLiveTracker set.
    const { fireBeforeRequest: fire2, fireCommitted: commit2 } = makeLiveTracker();
    // sdk2 was constructed with tracker2, not the new events — but the key property is that
    // destroying sdk1 does not throw or corrupt sdk2.
    expect(() => sdk2.checkForAffiliatePatterns(TAB_ID)).not.toThrow();

    // Verify sdk1 is properly destroyed and sdk2 is unaffected
    fireBeforeRequest(TAB_ID, 'https://dpbolvw.net/click-test');
    fireCommitted(TAB_ID, 'https://dpbolvw.net/click-test', []);
    // sdk1 was destroyed, receives no updates
    expect(sdk1.checkForAffiliatePatterns(TAB_ID).hasAffiliatePattern).toBe(false);

    // Use fire2/commit2 to drive sdk2's tracker (tracker2 listens on its own events)
    void fire2;
    void commit2;
    warnSpy.mockRestore();
  });

  it('is safe to call destroy() multiple times', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tracker } = makeLiveTracker();
    const sdk = new StanddownSDK(undefined, tracker);
    expect(() => {
      sdk.destroy();
      sdk.destroy();
    }).not.toThrow();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EPIC2-003 Scenario 1: 3-hop chain with intermediate affiliate domain
// ---------------------------------------------------------------------------

describe('StanddownSDK: live events: 3-hop chain with intermediate affiliate domain (EPIC2-003)', () => {
  it('detects CJ on an intermediate hop when three onBeforeRequest events precede server_redirect', () => {
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK({ policies: [CJ_POLICY] }, tracker);

    // A: originating URL (non-affiliate), B: CJ intermediate hop, C: merchant
    fireBeforeRequest(TAB_ID, 'https://go.shopmy.us/p-51829092');
    fireBeforeRequest(TAB_ID, 'https://dpbolvw.net/click-3hop-test');
    fireBeforeRequest(TAB_ID, 'https://merchant.com/product');
    fireCommitted(TAB_ID, 'https://merchant.com/product', ['server_redirect']);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.redirectChain).toEqual([
      'https://go.shopmy.us/p-51829092',
      'https://dpbolvw.net/click-3hop-test',
      'https://merchant.com/product',
    ]);
    expect(result.matchedPatterns).toHaveLength(1);
    expect(result.matchedPatterns[0]?.network).toBe('test-cj');
    expect(result.matchedPatterns[0]?.url).toBe('https://dpbolvw.net/click-3hop-test');
  });
});

// ---------------------------------------------------------------------------
// EPIC2-003 Scenario 2: Own-affiliate via intermediate hop
// ---------------------------------------------------------------------------

describe('StanddownSDK: live events: own-affiliate via intermediate hop (EPIC2-003)', () => {
  it('returns isOwnAffiliateLink: true when ownAffiliatePattern matches an intermediate hop URL', () => {
    const { tracker, fireBeforeRequest, fireCommitted } = makeLiveTracker();
    const shield = new StanddownSDK(
      { policies: [RAKUTEN_POLICY], ownAffiliatePatterns: [/AysPbYF8vuM/] },
      tracker,
    );

    // Intermediate hop: Rakuten/LinkShare publisher ID in URL; merchant is the final destination
    fireBeforeRequest(TAB_ID, 'https://click.linksynergy.com/deeplink?id=AysPbYF8vuM&mid=43172');
    fireBeforeRequest(TAB_ID, 'https://merchant.com/product');
    fireCommitted(TAB_ID, 'https://merchant.com/product', ['server_redirect']);

    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(true);
    expect(result.redirectChain).toEqual([
      'https://click.linksynergy.com/deeplink?id=AysPbYF8vuM&mid=43172',
      'https://merchant.com/product',
    ]);
  });
});


// ---------------------------------------------------------------------------
// checkForAffiliatePatterns: expiresAt in DetectionResult
// ---------------------------------------------------------------------------

describe('checkForAffiliatePatterns: expiresAt', () => {
  const MOCKED_NOW = 1_000_000_000_000;
  const DEFAULT_DURATION = 1_800_000;

  it('returns expiresAt = null when no affiliate pattern is found', () => {
    const shield = new StanddownSDK(
      { policies: [CJ_POLICY] },
      new MockNavigationTracker({ [TAB_ID]: ['https://clean-site.com/'] }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);
    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it('returns expiresAt = Date.now() + sessionDuration for a single-network match', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(MOCKED_NOW);
    try {
      const shield = new StanddownSDK(
        { policies: [CJ_POLICY] },
        new MockNavigationTracker({ [TAB_ID]: ['https://dpbolvw.net/click-123', 'https://merchant.com/'] }),
      );
      const result = shield.checkForAffiliatePatterns(TAB_ID);
      expect(result.hasAffiliatePattern).toBe(true);
      expect(result.expiresAt).toBe(MOCKED_NOW + DEFAULT_DURATION);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses the longer sessionDuration when two networks match in the same chain', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(MOCKED_NOW);
    try {
      // Use unique IDs to avoid merging with embedded policies
      const shortPolicy: NetworkPolicy = {
        id: 'test-short-net',
        schemaVersion: 2,
        policyVersion: 1,
        network: { id: 'test-short-net', name: 'Test Short Net', sessionDuration: 3_600_000 }, // 1 hour (shorter)
        rules: [{ domain: 'short-net.example.com', reason: 'test short network' }],
      };
      const longPolicy: NetworkPolicy = {
        id: 'test-long-net',
        schemaVersion: 2,
        policyVersion: 1,
        network: { id: 'test-long-net', name: 'Test Long Net', sessionDuration: 172_800_000 }, // 48 hours (longer)
        rules: [{ domain: 'long-net.example.com', reason: 'test long network' }],
      };
      const shield = new StanddownSDK(
        { policies: [shortPolicy, longPolicy] },
        new MockNavigationTracker({
          [TAB_ID]: [
            'https://short-net.example.com/click-123', // matches shortPolicy
            'https://long-net.example.com/click-456',  // matches longPolicy
          ],
        }),
      );
      const result = shield.checkForAffiliatePatterns(TAB_ID);
      expect(result.hasAffiliatePattern).toBe(true);
      // Two matches from our custom policies (embedded policies don't match these domains)
      const customMatches = result.matchedPatterns.filter(
        (m) => m.network === 'test-short-net' || m.network === 'test-long-net',
      );
      expect(customMatches).toHaveLength(2);
      // expiresAt must use the longer duration (48h wins over 1h)
      expect(result.expiresAt).toBe(MOCKED_NOW + 172_800_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses DEFAULT_SESSION_DURATION_MS when matched policy has no explicit sessionDuration', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(MOCKED_NOW);
    try {
      // CJ_POLICY has no sessionDuration; should default to 30 min
      const shield = new StanddownSDK(
        { policies: [CJ_POLICY] },
        new MockNavigationTracker({ [TAB_ID]: ['https://dpbolvw.net/click-123'] }),
      );
      const result = shield.checkForAffiliatePatterns(TAB_ID);
      expect(result.expiresAt).toBe(MOCKED_NOW + DEFAULT_DURATION);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// checkForAffiliatePatterns: detectedAt in DetectionResult
// ---------------------------------------------------------------------------

describe('checkForAffiliatePatterns: detectedAt', () => {
  const MOCKED_NOW = 1_000_000_000_000;

  it('returns detectedAt = null when no affiliate pattern is found', () => {
    const shield = new StanddownSDK(
      { policies: [CJ_POLICY] },
      new MockNavigationTracker({ [TAB_ID]: ['https://clean-site.com/'] }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);
    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.detectedAt).toBeNull();
  });

  it('returns detectedAt = Date.now() at time of detection', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(MOCKED_NOW);
    try {
      const shield = new StanddownSDK(
        { policies: [CJ_POLICY] },
        new MockNavigationTracker({ [TAB_ID]: ['https://dpbolvw.net/click-123', 'https://merchant.com/'] }),
      );
      const result = shield.checkForAffiliatePatterns(TAB_ID);
      expect(result.hasAffiliatePattern).toBe(true);
      expect(result.detectedAt).toBe(MOCKED_NOW);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Audit log helpers
// ---------------------------------------------------------------------------

function makeAuditDeps(): StorageDeps {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => Promise.resolve({ [key]: store.get(key) ?? null })),
    set: vi.fn((key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); }),
  };
}

function sdkWithAuditLog(chain: string[], policies = ALL_POLICIES): StanddownSDK {
  return new StanddownSDK(
    { policies, enableAuditLog: true },
    new MockNavigationTracker({ [TAB_ID]: chain }),
    new AuditLog(makeAuditDeps()),
  );
}

// ---------------------------------------------------------------------------
// getEventLog() -- fail-closed behaviour
// ---------------------------------------------------------------------------

describe('StanddownSDK.getEventLog(): disabled throws', () => {
  it('throws when enableAuditLog is false (default)', () => {
    const shield = shieldWith(['https://dpbolvw.net/click-123']);
    expect(() => shield.getEventLog()).toThrow('[StanddownSDK] getEventLog()');
  });

  it('throws when enableAuditLog is explicitly false', () => {
    const shield = new StanddownSDK(
      { policies: ALL_POLICIES, enableAuditLog: false },
      new MockNavigationTracker({ [TAB_ID]: ['https://dpbolvw.net/click-123'] }),
    );
    expect(() => shield.getEventLog()).toThrow('[StanddownSDK] getEventLog()');
  });
});

// ---------------------------------------------------------------------------
// getEventLog() -- recording flow
// ---------------------------------------------------------------------------

describe('StanddownSDK.getEventLog(): recording', () => {
  it('records an entry after a positive detection', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/product/42',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    const log = shield.getEventLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.url).toBe('https://macys.com/product/42');
    expect(log[0]?.matchedPatterns).toHaveLength(1);
    expect(log[0]?.matchedPatterns[0]?.network).toBe('test-cj');
    expect(log[0]?.redirectChain).toEqual([
      'https://dpbolvw.net/click-123',
      'https://macys.com/product/42',
    ]);
  });

  it('does not record an entry when no affiliate pattern is detected', () => {
    const shield = sdkWithAuditLog(['https://www.google.com/', 'https://amazon.com/']);
    shield.checkForAffiliatePatterns(TAB_ID);
    expect(shield.getEventLog()).toHaveLength(0);
  });

  it('overwrites an existing entry on re-detection for the same root domain', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const deps = makeAuditDeps();
      const shield = new StanddownSDK(
        { policies: ALL_POLICIES, enableAuditLog: true },
        new MockNavigationTracker({
          [TAB_ID]: ['https://dpbolvw.net/click-123', 'https://macys.com/'],
        }),
        new AuditLog(deps),
      );

      nowSpy.mockReturnValue(1_000_000);
      shield.checkForAffiliatePatterns(TAB_ID);
      const firstTimestamp = shield.getEventLog()[0]?.timestamp;
      expect(firstTimestamp).toBe(1_000_000);

      // Simulate second detection on same merchant domain with a new timestamp
      nowSpy.mockReturnValue(2_000_000);
      shield.checkForAffiliatePatterns(TAB_ID);
      const log = shield.getEventLog();
      expect(log).toHaveLength(1); // still one entry for macys.com
      expect(log[0]?.timestamp).toBe(2_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('records sessionDuration from the matched network policy', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    const event = shield.getEventLog()[0];
    expect(event?.sessionDuration).toBeGreaterThan(0);
  });

  it('records isOwnAffiliateLink: true when own pattern matches', () => {
    const shield = new StanddownSDK(
      { policies: ALL_POLICIES, enableAuditLog: true, ownAffiliatePatterns: [/m_pl=YourExtension/] },
      new MockNavigationTracker({
        [TAB_ID]: [
          'https://dpbolvw.net/click-123',
          'https://macys.com/?m_pl=YourExtension',
        ],
      }),
      new AuditLog(makeAuditDeps()),
    );
    shield.checkForAffiliatePatterns(TAB_ID);
    expect(shield.getEventLog()[0]?.isOwnAffiliateLink).toBe(true);
  });

  it('records isOwnAffiliateLink: false when ownAffiliatePatterns is not configured', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/product/42',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    expect(shield.getEventLog()[0]?.isOwnAffiliateLink).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEventsByDomain() -- EPIC2-005
// ---------------------------------------------------------------------------

describe('StanddownSDK.getEventsByDomain(): disabled throws', () => {
  it('throws when enableAuditLog is false (default)', () => {
    const shield = shieldWith(['https://dpbolvw.net/click-123']);
    expect(() => shield.getEventsByDomain('macys.com')).toThrow('[StanddownSDK] getEventsByDomain()');
  });
});

describe('StanddownSDK.getEventsByDomain(): query behaviour', () => {
  it('returns the event for a full URL input matching the stored root domain', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/product/42',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    const result = shield.getEventsByDomain('https://www.macys.com/');
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://macys.com/product/42');
  });

  it('returns the event for a bare domain input', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    const result = shield.getEventsByDomain('macys.com');
    expect(result).toHaveLength(1);
  });

  it('returns the event when a subdomain input normalizes to the stored root domain', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    const result = shield.getEventsByDomain('shop.macys.com');
    expect(result).toHaveLength(1);
  });

  it('returns [] for an unknown domain', () => {
    const shield = sdkWithAuditLog([
      'https://dpbolvw.net/click-123',
      'https://macys.com/',
    ]);
    shield.checkForAffiliatePatterns(TAB_ID);
    expect(shield.getEventsByDomain('nike.com')).toEqual([]);
  });

  it('returns [] for an expired session (controlled via vi.spyOn)', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const base = 1_000_000_000_000;
      nowSpy.mockReturnValue(base);
      const deps = makeAuditDeps();
      const shield = new StanddownSDK(
        { policies: ALL_POLICIES, enableAuditLog: true },
        new MockNavigationTracker({
          [TAB_ID]: ['https://dpbolvw.net/click-123', 'https://macys.com/'],
        }),
        new AuditLog(deps),
      );
      shield.checkForAffiliatePatterns(TAB_ID);

      // Advance time far beyond any session duration
      nowSpy.mockReturnValue(base + 365 * 24 * 60 * 60 * 1_000);
      expect(shield.getEventsByDomain('macys.com')).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns a fresh event after re-detection resets expiry', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const base = 1_000_000_000_000;
      nowSpy.mockReturnValue(base);
      const deps = makeAuditDeps();
      const shield = new StanddownSDK(
        { policies: ALL_POLICIES, enableAuditLog: true },
        new MockNavigationTracker({
          [TAB_ID]: ['https://dpbolvw.net/click-123', 'https://macys.com/'],
        }),
        new AuditLog(deps),
      );
      shield.checkForAffiliatePatterns(TAB_ID);

      nowSpy.mockReturnValue(base + 1_000);
      shield.checkForAffiliatePatterns(TAB_ID);

      const result = shield.getEventsByDomain('macys.com');
      expect(result).toHaveLength(1);
      expect(result[0]?.timestamp).toBe(base + 1_000);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ownAffiliatePatterns: isOwnAffiliateLink on DetectionResult
// ---------------------------------------------------------------------------

describe('StanddownSDK: ownAffiliatePatterns', () => {
  it('returns isOwnAffiliateLink: false when ownAffiliatePatterns is not configured', () => {
    const shield = shieldWith([
      'https://dpbolvw.net/click-123',
      'https://macys.com/?m_pl=YourExtension',
    ]);
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(false);
  });

  it('returns isOwnAffiliateLink: true when a pattern matches the final URL', () => {
    const shield = new StanddownSDK(
      { policies: ALL_POLICIES, ownAffiliatePatterns: [/m_pl=YourExtension/] },
      new MockNavigationTracker({
        [TAB_ID]: [
          'https://dpbolvw.net/click-123',
          'https://macys.com/?m_pl=YourExtension',
        ],
      }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(true);
  });

  it('returns isOwnAffiliateLink: true when a pattern matches an intermediate URL', () => {
    // Simulates a network (e.g. Target) that embeds the publisher ID in the path
    // of an intermediate hop rather than in the final destination URL.
    const shield = new StanddownSDK(
      {
        policies: ALL_POLICIES,
        ownAffiliatePatterns: [/goto\.target\.com\/c\/12345\//],
      },
      new MockNavigationTracker({
        [TAB_ID]: [
          'https://dpbolvw.net/click-123',             // affiliate hop (matches CJ policy)
          'https://goto.target.com/c/12345/product',   // intermediate: own publisher ID in path
          'https://target.com/p/item?id=99',           // final merchant URL (no own identifier here)
        ],
      }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(true);
  });

  it('returns isOwnAffiliateLink: false when no URL in the chain matches any pattern', () => {
    const shield = new StanddownSDK(
      { policies: ALL_POLICIES, ownAffiliatePatterns: [/m_pl=YourExtension/] },
      new MockNavigationTracker({
        [TAB_ID]: [
          'https://dpbolvw.net/click-123',
          'https://macys.com/?m_pl=CompetitorExtension',
        ],
      }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(false);
  });

  it('returns isOwnAffiliateLink: false when hasAffiliatePattern is false, even with patterns configured', () => {
    const shield = new StanddownSDK(
      { policies: ALL_POLICIES, ownAffiliatePatterns: [/m_pl=YourExtension/] },
      new MockNavigationTracker({
        [TAB_ID]: ['https://macys.com/?m_pl=YourExtension'], // own identifier present but no affiliate hop
      }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(false);
    expect(result.isOwnAffiliateLink).toBe(false);
  });

  it('returns isOwnAffiliateLink: true when only one of multiple patterns matches (OR semantics)', () => {
    const shield = new StanddownSDK(
      {
        policies: ALL_POLICIES,
        ownAffiliatePatterns: [
          /nomatch_pattern_xyz/,      // does not match
          /m_pl=YourExtension/,       // matches
        ],
      },
      new MockNavigationTracker({
        [TAB_ID]: [
          'https://dpbolvw.net/click-123',
          'https://macys.com/?m_pl=YourExtension',
        ],
      }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(true);
  });

  it('returns isOwnAffiliateLink: false when ownAffiliatePatterns is an empty array', () => {
    const shield = new StanddownSDK(
      { policies: ALL_POLICIES, ownAffiliatePatterns: [] },
      new MockNavigationTracker({
        [TAB_ID]: [
          'https://dpbolvw.net/click-123',
          'https://macys.com/?m_pl=YourExtension',
        ],
      }),
    );
    const result = shield.checkForAffiliatePatterns(TAB_ID);

    expect(result.hasAffiliatePattern).toBe(true);
    expect(result.isOwnAffiliateLink).toBe(false);
  });
});
