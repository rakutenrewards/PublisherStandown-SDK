/**
 * NavigationTracker unit tests
 *
 * All chrome events are replaced with in-memory mock emitters so tests run
 * in Node.js without any browser globals.
 *
 * Two modes are exercised:
 * - headers mode (Chrome/Firefox/Edge): onHeadersReceived, status-code driven.
 * - navigation-only mode (Safari): onBeforeNavigate + onCommitted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NavigationTracker } from '../../src/detection/tracker.js';
import type {
  BeforeNavigateDetails,
  CommittedDetails,
  HeadersReceivedDetails,
  TrackerDeps,
} from '../../src/detection/tracker.js';
import { makeMockEvent } from '../helpers/mock-events.js';

// Common status codes for readability in tests.
const REDIRECT = 302; // 3xx: buffers a hop
const OK = 200; // non-3xx: closes the chain

/** Creates a headers-mode TrackerDeps bundle with controllable mock events. */
function makeDeps() {
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
  return {
    deps: { onHeadersReceived, onTabRemoved } satisfies TrackerDeps,
    fireHeaders: (tabId: number, url: string, statusCode: number, type = 'main_frame') =>
      onHeadersReceivedImpl.fire({ tabId, url, type, statusCode }),
    fireTabRemoved: onTabRemoved.fire.bind(onTabRemoved),
  };
}

// ---------------------------------------------------------------------------
// getChain() -- base state (shared)
// ---------------------------------------------------------------------------

describe('NavigationTracker: getChain()', () => {
  it('returns [] for an unknown tabId', () => {
    const { deps } = makeDeps();
    const tracker = new NavigationTracker(deps);
    expect(tracker.getChain(99)).toEqual([]);
  });

  it('returns [] when constructed with no deps (stub mode)', () => {
    const tracker = new NavigationTracker();
    expect(tracker.getChain(1)).toEqual([]);
  });
});

// ===========================================================================
// HEADERS MODE (Chrome / Firefox / Edge) -- onHeadersReceived
// ===========================================================================

describe('NavigationTracker: headers mode: buffer accumulation and filtering', () => {
  it('buffers 3xx hops and closes the chain on the final 2xx', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', REDIRECT);
    fireHeaders(1, 'https://b.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('captures A, B, C across a multi-hop redirect chain', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', REDIRECT);
    fireHeaders(1, 'https://dpbolvw.net/click-123', REDIRECT);
    fireHeaders(1, 'https://merchant.com/', OK);
    expect(tracker.getChain(1)).toEqual([
      'https://a.com/',
      'https://dpbolvw.net/click-123',
      'https://merchant.com/',
    ]);
  });

  it('ignores sub_frame type', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://frame.com/', REDIRECT, 'sub_frame');
    fireHeaders(1, 'https://other.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://other.com/']);
  });

  it('ignores xmlhttprequest type', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://api.example.com/data', REDIRECT, 'xmlhttprequest');
    fireHeaders(1, 'https://merchant.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://merchant.com/']);
  });

  it('ignores tabId < 0', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(-1, 'https://background.com/', REDIRECT);
    fireHeaders(1, 'https://merchant.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://merchant.com/']);
  });

  it('maintains separate buffers per tab', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://tab1-a.com/', REDIRECT);
    fireHeaders(2, 'https://tab2-a.com/', OK);
    fireHeaders(1, 'https://tab1-b.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://tab1-a.com/', 'https://tab1-b.com/']);
    expect(tracker.getChain(2)).toEqual(['https://tab2-a.com/']);
  });
});

describe('NavigationTracker: headers mode: direct navigation', () => {
  it('treats a lone 2xx (no prior buffer) as a direct navigation', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://direct.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://direct.com/']);
  });

  it('resets the chain when a fresh direct navigation follows a redirect chain', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    // First: affiliate redirect chain
    fireHeaders(1, 'https://dpbolvw.net/click-123', REDIRECT);
    fireHeaders(1, 'https://merchant.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://dpbolvw.net/click-123', 'https://merchant.com/']);
    // Then: user navigates directly to a clean site
    fireHeaders(1, 'https://clean-site.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://clean-site.com/']);
  });
});

describe('NavigationTracker: headers mode: non-3xx status codes close the chain', () => {
  it('closes the chain on a 4xx response', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', REDIRECT);
    fireHeaders(1, 'https://notfound.com/', 404);
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://notfound.com/']);
  });

  it('closes the chain on a 5xx response', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', REDIRECT);
    fireHeaders(1, 'https://error.com/', 500);
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://error.com/']);
  });
});

describe('NavigationTracker: headers mode: deduplication', () => {
  it('collapses a duplicate URL to its first occurrence in the chain', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', REDIRECT);
    fireHeaders(1, 'https://b.com/', REDIRECT);
    fireHeaders(1, 'https://a.com/', REDIRECT); // duplicate hop
    fireHeaders(1, 'https://b.com/', OK); // committed equals last buffered
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });
});

describe('NavigationTracker: headers mode: onTabRemoved', () => {
  it('removes the chain for the closed tab', () => {
    const { deps, fireHeaders, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://example.com/', OK);
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('clears an in-flight buffer (before the chain settles)', () => {
    const { deps, fireHeaders, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://example.com/', REDIRECT); // buffered, not yet closed
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('does not affect other tabs', () => {
    const { deps, fireHeaders, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://tab1.com/', OK);
    fireHeaders(2, 'https://tab2.com/', OK);
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
    expect(tracker.getChain(2)).toEqual(['https://tab2.com/']);
  });

  it('allows the tab chain to be rebuilt after removal', () => {
    const { deps, fireHeaders, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://first.com/', OK);
    fireTabRemoved(1);
    fireHeaders(1, 'https://second.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://second.com/']);
  });

  it('is a no-op for a tabId that was never tracked', () => {
    const { deps, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireTabRemoved(999);
    expect(tracker.getChain(999)).toEqual([]);
  });
});

describe('NavigationTracker: headers mode: destroy()', () => {
  it('is a no-op on a stub-mode tracker (no deps)', () => {
    const tracker = new NavigationTracker();
    expect(() => tracker.destroy()).not.toThrow();
  });

  it('stops processing onHeadersReceived events after destroy', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', REDIRECT);
    fireHeaders(1, 'https://b.com/', OK);
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);

    tracker.destroy();

    fireHeaders(1, 'https://c.com/', OK);
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('stops processing onTabRemoved events after destroy', () => {
    const { deps, fireHeaders, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', OK);
    tracker.destroy();
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]); // already cleared by destroy
  });

  it('clears all per-tab chain state on destroy', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(1, 'https://a.com/', OK);
    fireHeaders(2, 'https://b.com/', OK);
    tracker.destroy();
    expect(tracker.getChain(1)).toEqual([]);
    expect(tracker.getChain(2)).toEqual([]);
  });

  it('is safe to call destroy() multiple times', () => {
    const { deps } = makeDeps();
    const tracker = new NavigationTracker(deps);
    expect(() => {
      tracker.destroy();
      tracker.destroy();
    }).not.toThrow();
  });
});

// ===========================================================================
// NAVIGATION-ONLY MODE (Safari) -- onBeforeNavigate + onCommitted
// ===========================================================================

/** Creates a nav-only TrackerDeps bundle (onBeforeNavigate + onCommitted). */
function makeNavOnlyDeps() {
  const onBeforeNavigateImpl = makeMockEvent<BeforeNavigateDetails>();
  const onBeforeNavigate = {
    addListener(cb: (d: BeforeNavigateDetails) => void) {
      onBeforeNavigateImpl.addListener(cb);
    },
    removeListener(cb: (d: BeforeNavigateDetails) => void) {
      onBeforeNavigateImpl.removeListener(cb);
    },
  };

  const onCommitted = makeMockEvent<CommittedDetails>();
  const onTabRemoved = makeMockEvent<number>();

  return {
    deps: { onBeforeNavigate, onCommitted, onTabRemoved } satisfies TrackerDeps,
    fireBeforeNavigate: (tabId: number, url: string, frameId = 0) =>
      onBeforeNavigateImpl.fire({ tabId, url, frameId }),
    fireCommitted: (
      tabId: number,
      url: string,
      transitionQualifiers: string[] | null = [],
      frameId = 0,
    ) => onCommitted.fire({ tabId, url, frameId, transitionQualifiers }),
    fireTabRemoved: onTabRemoved.fire.bind(onTabRemoved),
  };
}

describe('NavigationTracker: nav-only mode: Safari null-qualifier heuristic', () => {
  it('treats a differing committed URL (null qualifiers) as a redirect', () => {
    // Real Safari case: onBeforeNavigate fires for the affiliate URL, the server
    // redirects silently, onCommitted fires for the merchant URL with null qualifiers.
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(1, 'https://dpbolvw.net/click-safari');
    fireCommitted(1, 'https://merchant.com/landing', null);
    expect(tracker.getChain(1)).toEqual([
      'https://dpbolvw.net/click-safari',
      'https://merchant.com/landing',
    ]);
  });

  it('treats an equal committed URL (null qualifiers) as a direct navigation', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(1, 'https://d.com/');
    fireCommitted(1, 'https://d.com/', null);
    expect(tracker.getChain(1)).toEqual(['https://d.com/']);
  });

  it('detects an affiliate param that survives to the committed URL', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(1, 'https://affiliate.net/click?cjevent=abc123');
    fireCommitted(1, 'https://merchant.com/?afsrc=1', null);
    expect(tracker.getChain(1)).toEqual([
      'https://affiliate.net/click?cjevent=abc123',
      'https://merchant.com/?afsrc=1',
    ]);
  });

  it('does not throw when committed URL has null qualifiers and no buffer', () => {
    const { deps, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    expect(() => fireCommitted(1, 'https://example.com/', null)).not.toThrow();
    expect(tracker.getChain(1)).toEqual(['https://example.com/']);
  });
});

describe('NavigationTracker: nav-only mode: transition qualifiers', () => {
  let tracker: NavigationTracker;
  let fireBeforeNavigate: ReturnType<typeof makeNavOnlyDeps>['fireBeforeNavigate'];
  let fireCommitted: ReturnType<typeof makeNavOnlyDeps>['fireCommitted'];

  beforeEach(() => {
    const d = makeNavOnlyDeps();
    tracker = new NavigationTracker(d.deps);
    fireBeforeNavigate = d.fireBeforeNavigate;
    fireCommitted = d.fireCommitted;
  });

  it('retains the chain on "server_redirect"', () => {
    fireBeforeNavigate(1, 'https://affiliate.com/click');
    fireCommitted(1, 'https://merchant.com/', ['server_redirect']);
    expect(tracker.getChain(1)).toEqual(['https://affiliate.com/click', 'https://merchant.com/']);
  });

  it('retains the chain on "client_redirect"', () => {
    fireBeforeNavigate(1, 'https://tracker.com/');
    fireCommitted(1, 'https://destination.com/', ['client_redirect']);
    expect(tracker.getChain(1)).toEqual(['https://tracker.com/', 'https://destination.com/']);
  });

  it('retains the chain on Firefox "redirect" qualifier', () => {
    fireBeforeNavigate(1, 'https://affiliate.com/click');
    fireCommitted(1, 'https://merchant.com/', ['redirect']);
    expect(tracker.getChain(1)).toEqual(['https://affiliate.com/click', 'https://merchant.com/']);
  });

  it('retains the chain when a redirect qualifier appears alongside others', () => {
    fireBeforeNavigate(1, 'https://a.com/');
    fireCommitted(1, 'https://b.com/', ['from_address_bar', 'server_redirect']);
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('resets the chain on empty [] qualifiers (user navigation)', () => {
    fireBeforeNavigate(1, 'https://a.com/');
    fireCommitted(1, 'https://b.com/', []);
    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });

  it('resets the chain on a non-redirect qualifier ("forward_back")', () => {
    fireBeforeNavigate(1, 'https://a.com/');
    fireCommitted(1, 'https://b.com/', ['forward_back']);
    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });

  it('does NOT activate the Safari heuristic for empty [] qualifiers (Chrome/Firefox regression)', () => {
    // [] is not null; the Safari null-heuristic must stay off so this is a user nav.
    fireBeforeNavigate(1, 'https://a.com/');
    fireCommitted(1, 'https://b.com/', []);
    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });
});

describe('NavigationTracker: nav-only mode: frame and tab filtering', () => {
  it('ignores onBeforeNavigate for non-zero frameId', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(1, 'https://iframe.com/', 1); // frameId=1, ignored
    fireCommitted(1, 'https://merchant.com/', []);
    expect(tracker.getChain(1)).toEqual(['https://merchant.com/']);
  });

  it('ignores onCommitted for non-zero frameId', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(1, 'https://a.com/');
    fireCommitted(1, 'https://b.com/', [], 1); // frameId=1, ignored → chain unsettled
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('ignores onBeforeNavigate for tabId < 0', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(-1, 'https://background.com/');
    fireCommitted(1, 'https://merchant.com/', []);
    expect(tracker.getChain(1)).toEqual(['https://merchant.com/']);
  });
});

describe('NavigationTracker: nav-only mode: onTabRemoved and destroy()', () => {
  it('clears the chain on tab removal', () => {
    const { deps, fireBeforeNavigate, fireCommitted, fireTabRemoved } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(1, 'https://affiliate.net/');
    fireCommitted(1, 'https://merchant.com/', null);
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('removes onBeforeNavigate and onCommitted listeners on destroy', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    tracker.destroy();
    fireBeforeNavigate(1, 'https://affiliate.net/');
    fireCommitted(1, 'https://merchant.com/', null);
    expect(tracker.getChain(1)).toEqual([]);
  });
});

// ===========================================================================
// Realistic end-to-end sequences
// ===========================================================================

describe('NavigationTracker: realistic affiliate redirect sequence', () => {
  it('headers mode: builds a complete affiliate chain through multiple redirects', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(5, 'https://affiliate-network.com/click?id=123', REDIRECT);
    fireHeaders(5, 'https://merchant.com/product', OK);
    expect(tracker.getChain(5)).toEqual([
      'https://affiliate-network.com/click?id=123',
      'https://merchant.com/product',
    ]);
  });

  it('headers mode: resets the chain when the user navigates away then returns', () => {
    const { deps, fireHeaders } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireHeaders(5, 'https://affiliate.com/', REDIRECT);
    fireHeaders(5, 'https://merchant.com/', OK);
    fireHeaders(5, 'https://new-site.com/', OK);
    expect(tracker.getChain(5)).toEqual(['https://new-site.com/']);
  });

  it('nav-only mode: builds an affiliate chain from a single-hop Safari redirect', () => {
    const { deps, fireBeforeNavigate, fireCommitted } = makeNavOnlyDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeNavigate(5, 'https://affiliate-network.com/click?id=123');
    fireCommitted(5, 'https://merchant.com/product', null);
    expect(tracker.getChain(5)).toEqual([
      'https://affiliate-network.com/click?id=123',
      'https://merchant.com/product',
    ]);
  });
});
