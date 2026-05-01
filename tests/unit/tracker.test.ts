/**
 * NavigationTracker unit tests
 *
 * All chrome events are replaced with in-memory mock emitters so tests run
 * in Node.js without any browser globals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NavigationTracker } from '../../src/detection/tracker.js';
import type {
  BeforeRequestDetails,
  CommittedDetails,
  TrackerDeps,
} from '../../src/detection/tracker.js';
import { makeMockEvent } from '../helpers/mock-events.js';

/** Creates a TrackerDeps bundle with controllable mock events. */
function makeDeps() {
  const onBeforeRequestImpl = makeMockEvent<BeforeRequestDetails>();
  const onBeforeRequest = {
    addListener(cb: (d: BeforeRequestDetails) => void, _filter: unknown) {
      onBeforeRequestImpl.addListener(cb);
    },
    removeListener(cb: (d: BeforeRequestDetails) => void) {
      onBeforeRequestImpl.removeListener(cb);
    },
  };
  const fireBeforeRequest = onBeforeRequestImpl.fire.bind(onBeforeRequestImpl);

  const onCommitted = makeMockEvent<CommittedDetails>();
  const onTabRemoved = makeMockEvent<number>();
  return {
    deps: { onBeforeRequest, onCommitted, onTabRemoved } satisfies TrackerDeps,
    fireBeforeRequest,
    fireCommitted: onCommitted.fire.bind(onCommitted),
    fireTabRemoved: onTabRemoved.fire.bind(onTabRemoved),
  };
}

/** Shorthand: build a BeforeRequestDetails object. */
function beforeReq(tabId: number, url: string, type = 'main_frame'): BeforeRequestDetails {
  return { tabId, url, type };
}

/** Shorthand: build a CommittedDetails object. */
function committed(
  tabId: number,
  url: string,
  transitionQualifiers: string[] | null = [],
  frameId = 0,
): CommittedDetails {
  return { tabId, url, frameId, transitionQualifiers };
}

// ---------------------------------------------------------------------------
// getChain() -- base state
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

// ---------------------------------------------------------------------------
// onBeforeRequest -- buffer accumulation and filtering
// ---------------------------------------------------------------------------

describe('NavigationTracker: onBeforeRequest', () => {
  it('buffers a main_frame URL (visible via chain after redirect commit)', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('ignores sub_frame type', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://example.com/', 'sub_frame'));
    fireCommitted(committed(1, 'https://other.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://other.com/']);
  });

  it('ignores xmlhttprequest type', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://api.example.com/data', 'xmlhttprequest'));
    fireCommitted(committed(1, 'https://merchant.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://merchant.com/']);
  });

  it('ignores tabId < 0', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(-1, 'https://example.com/'));
    fireCommitted(committed(1, 'https://merchant.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://merchant.com/']);
  });

  it('maintains separate buffers per tab', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://tab1-a.com/'));
    fireBeforeRequest(beforeReq(2, 'https://tab2-a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://tab1-b.com/'));
    fireCommitted(committed(1, 'https://tab1-b.com/', ['server_redirect']));
    fireCommitted(committed(2, 'https://tab2-a.com/', []));
    expect(tracker.getChain(1)).toEqual(['https://tab1-a.com/', 'https://tab1-b.com/']);
    expect(tracker.getChain(2)).toEqual(['https://tab2-a.com/']);
  });

  it('accumulates multiple URLs in insertion order', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireBeforeRequest(beforeReq(1, 'https://c.com/'));
    fireCommitted(committed(1, 'https://c.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/', 'https://c.com/']);
  });
});

// ---------------------------------------------------------------------------
// onCommitted -- user nav reset vs. redirect continuation
// ---------------------------------------------------------------------------

describe('NavigationTracker: onCommitted: user-initiated navigation', () => {
  let tracker: NavigationTracker;
  let fireBeforeRequest: ReturnType<typeof makeDeps>['fireBeforeRequest'];
  let fireCommitted: ReturnType<typeof makeDeps>['fireCommitted'];

  beforeEach(() => {
    const deps = makeDeps();
    tracker = new NavigationTracker(deps.deps);
    fireBeforeRequest = deps.fireBeforeRequest;
    fireCommitted = deps.fireCommitted;
  });

  it('clears chain and starts fresh on empty transitionQualifiers', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://c.com/', []));

    expect(tracker.getChain(1)).toEqual(['https://c.com/']);
  });

  it('clears chain when transitionQualifiers has no redirect qualifier', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['typed']));

    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });

  it('ignores onCommitted with non-zero frameId (no chain change)', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireCommitted(committed(1, 'https://b.com/', [], 1)); // frameId=1

    // Chain has not settled yet (no redirect commit for frameId=0); getChain returns []
    expect(tracker.getChain(1)).toEqual([]);
  });
});

describe('NavigationTracker: onCommitted: redirect continuation', () => {
  let tracker: NavigationTracker;
  let fireBeforeRequest: ReturnType<typeof makeDeps>['fireBeforeRequest'];
  let fireCommitted: ReturnType<typeof makeDeps>['fireCommitted'];

  beforeEach(() => {
    const deps = makeDeps();
    tracker = new NavigationTracker(deps.deps);
    fireBeforeRequest = deps.fireBeforeRequest;
    fireCommitted = deps.fireCommitted;
  });

  it('retains chain on "server_redirect"', () => {
    fireBeforeRequest(beforeReq(1, 'https://affiliate.com/click'));
    fireBeforeRequest(beforeReq(1, 'https://merchant.com/'));
    fireCommitted(committed(1, 'https://merchant.com/', ['server_redirect']));

    expect(tracker.getChain(1)).toEqual([
      'https://affiliate.com/click',
      'https://merchant.com/',
    ]);
  });

  it('retains chain on "client_redirect"', () => {
    fireBeforeRequest(beforeReq(1, 'https://tracker.com/'));
    fireBeforeRequest(beforeReq(1, 'https://destination.com/'));
    fireCommitted(committed(1, 'https://destination.com/', ['client_redirect']));

    expect(tracker.getChain(1)).toEqual([
      'https://tracker.com/',
      'https://destination.com/',
    ]);
  });

  it('retains chain when qualifiers include "server_redirect" alongside other qualifiers', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['typed', 'server_redirect']));

    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('retains chain when qualifiers include "client_redirect" alongside other qualifiers', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['from_address_bar', 'client_redirect']));

    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });
});

// ---------------------------------------------------------------------------
// onTabRemoved -- tab cleanup
// ---------------------------------------------------------------------------

describe('NavigationTracker: onTabRemoved', () => {
  it('removes the chain for the closed tab', () => {
    const { deps, fireBeforeRequest, fireCommitted, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://example.com/'));
    fireCommitted(committed(1, 'https://example.com/', []));
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('does not affect other tabs when one tab is closed', () => {
    const { deps, fireBeforeRequest, fireCommitted, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://tab1.com/'));
    fireBeforeRequest(beforeReq(2, 'https://tab2.com/'));
    fireCommitted(committed(1, 'https://tab1.com/', []));
    fireCommitted(committed(2, 'https://tab2.com/', []));
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
    expect(tracker.getChain(2)).toEqual(['https://tab2.com/']);
  });

  it('is a no-op for a tabId that was never tracked', () => {
    const { deps, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireTabRemoved(999);
    expect(tracker.getChain(999)).toEqual([]);
  });

  it('allows the tab chain to be rebuilt after removal', () => {
    const { deps, fireBeforeRequest, fireCommitted, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://first.com/'));
    fireCommitted(committed(1, 'https://first.com/', []));
    fireTabRemoved(1);
    fireBeforeRequest(beforeReq(1, 'https://second.com/'));
    fireCommitted(committed(1, 'https://second.com/', []));
    expect(tracker.getChain(1)).toEqual(['https://second.com/']);
  });
});

// ---------------------------------------------------------------------------
// Firefox redirect qualifier
// ---------------------------------------------------------------------------

describe('NavigationTracker: Firefox redirect qualifier', () => {
  let tracker: NavigationTracker;
  let fireBeforeRequest: ReturnType<typeof makeDeps>['fireBeforeRequest'];
  let fireCommitted: ReturnType<typeof makeDeps>['fireCommitted'];

  beforeEach(() => {
    const deps = makeDeps();
    tracker = new NavigationTracker(deps.deps);
    fireBeforeRequest = deps.fireBeforeRequest;
    fireCommitted = deps.fireCommitted;
  });

  it('retains chain on Firefox "redirect" qualifier (redirect continuation)', () => {
    fireBeforeRequest(beforeReq(1, 'https://affiliate.com/click'));
    fireBeforeRequest(beforeReq(1, 'https://merchant.com/'));
    fireCommitted(committed(1, 'https://merchant.com/', ['redirect']));

    expect(tracker.getChain(1)).toEqual([
      'https://affiliate.com/click',
      'https://merchant.com/',
    ]);
  });

  it('retains chain when qualifiers include "redirect" alongside other qualifiers', () => {
    fireBeforeRequest(beforeReq(1, 'https://affiliate.com/click'));
    fireBeforeRequest(beforeReq(1, 'https://merchant.com/'));
    fireCommitted(committed(1, 'https://merchant.com/', ['redirect', 'from_address_bar']));

    expect(tracker.getChain(1)).toEqual([
      'https://affiliate.com/click',
      'https://merchant.com/',
    ]);
  });

  it('resets chain on empty transitionQualifiers (user navigation)', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', []));

    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });

  it('resets chain on "forward_back" qualifier (non-redirect qualifier)', () => {
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['forward_back']));

    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });
});

// ---------------------------------------------------------------------------
// onBeforeRequest buffer accumulation -- new test group (EPIC2-001)
// ---------------------------------------------------------------------------

describe('NavigationTracker: onBeforeRequest buffer accumulation', () => {
  it('main_frame URL is buffered and captured in chain after redirect commit', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('sub_frame type is ignored (buffer unchanged)', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://main.com/', 'main_frame'));
    fireBeforeRequest(beforeReq(1, 'https://sub.com/', 'sub_frame'));
    fireCommitted(committed(1, 'https://main.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://main.com/']);
  });

  it('xmlhttprequest type is ignored', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://main.com/', 'main_frame'));
    fireBeforeRequest(beforeReq(1, 'https://api.com/data', 'xmlhttprequest'));
    fireCommitted(committed(1, 'https://main.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://main.com/']);
  });

  it('tabId < 0 is ignored', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://main.com/'));
    fireBeforeRequest(beforeReq(-1, 'https://background.com/'));
    fireCommitted(committed(1, 'https://main.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://main.com/']);
  });

  it('maintains separate buffers per tab', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://tab1-a.com/'));
    fireBeforeRequest(beforeReq(2, 'https://tab2-a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://tab1-b.com/'));
    fireCommitted(committed(1, 'https://tab1-b.com/', ['server_redirect']));
    fireCommitted(committed(2, 'https://tab2-a.com/', []));
    expect(tracker.getChain(1)).toEqual(['https://tab1-a.com/', 'https://tab1-b.com/']);
    expect(tracker.getChain(2)).toEqual(['https://tab2-a.com/']);
  });

  it('multiple URLs accumulate in insertion order', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireBeforeRequest(beforeReq(1, 'https://c.com/'));
    fireCommitted(committed(1, 'https://c.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/', 'https://c.com/']);
  });
});

// ---------------------------------------------------------------------------
// 3-hop redirect (qualifier path) -- EPIC2-001
// ---------------------------------------------------------------------------

describe('NavigationTracker: 3-hop redirect (qualifier path)', () => {
  it('captures A, B, C when three onBeforeRequest events precede a server_redirect commit', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://dpbolvw.net/click-123'));
    fireBeforeRequest(beforeReq(1, 'https://merchant.com/'));
    fireCommitted(committed(1, 'https://merchant.com/', ['server_redirect']));

    expect(tracker.getChain(1)).toEqual([
      'https://a.com/',
      'https://dpbolvw.net/click-123',
      'https://merchant.com/',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Buffer cleared on user navigation -- EPIC2-001
// ---------------------------------------------------------------------------

describe('NavigationTracker: buffer cleared on user navigation', () => {
  it('after non-redirect onCommitted with [], chain is [D] and no prior buffer URLs appear', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    // Build up a buffer for a prior navigation
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    // User navigates directly to D (no redirect)
    fireBeforeRequest(beforeReq(1, 'https://d.com/'));
    fireCommitted(committed(1, 'https://d.com/', []));

    expect(tracker.getChain(1)).toEqual(['https://d.com/']);
  });
});

// ---------------------------------------------------------------------------
// onTabRemoved clears buffer -- EPIC2-001
// ---------------------------------------------------------------------------

describe('NavigationTracker: onTabRemoved clears buffer', () => {
  it('getChain returns [] after tab removal even if buffer had entries', () => {
    const { deps, fireBeforeRequest, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://example.com/'));
    fireTabRemoved(1);

    expect(tracker.getChain(1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deduplication -- EPIC2-001
// ---------------------------------------------------------------------------

describe('NavigationTracker: deduplication', () => {
  it('same URL appearing twice in buffer results in only first occurrence in chain', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireBeforeRequest(beforeReq(1, 'https://a.com/')); // duplicate
    fireCommitted(committed(1, 'https://b.com/', ['server_redirect']));

    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });
});

// ---------------------------------------------------------------------------
// Safari buffer-length heuristic -- EPIC2-002
// ---------------------------------------------------------------------------

describe('NavigationTracker: Safari buffer-length heuristic', () => {
  it('direct nav (buffer=[D], len=1, null qualifiers) is treated as user nav; getChain returns [D]', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://d.com/'));
    fireCommitted(committed(1, 'https://d.com/', null));

    expect(tracker.getChain(1)).toEqual(['https://d.com/']);
  });

  it('single-hop redirect (buffer=[A,B], len=2, null qualifiers) is treated as redirect; getChain returns [A,B]', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', null));

    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('multi-hop redirect (buffer=[A,B,C], len=3, null qualifiers) captures all hops', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireBeforeRequest(beforeReq(1, 'https://c.com/'));
    fireCommitted(committed(1, 'https://c.com/', null));

    expect(tracker.getChain(1)).toEqual([
      'https://a.com/',
      'https://b.com/',
      'https://c.com/',
    ]);
  });

  it('Chrome regression: empty [] qualifiers with 2-URL buffer is treated as user nav (qualifier path takes precedence)', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    // [] is not null; Safari fallback must NOT activate
    fireCommitted(committed(1, 'https://b.com/', []));

    expect(tracker.getChain(1)).toEqual(['https://b.com/']);
  });

  it('Firefox regression: ["redirect"] qualifier still retains chain', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://affiliate.com/click'));
    fireBeforeRequest(beforeReq(1, 'https://merchant.com/'));
    fireCommitted(committed(1, 'https://merchant.com/', ['redirect']));

    expect(tracker.getChain(1)).toEqual([
      'https://affiliate.com/click',
      'https://merchant.com/',
    ]);
  });

  it('does not throw when transitionQualifiers is null and buffer is empty', () => {
    const { deps, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    expect(() => fireCommitted(committed(1, 'https://example.com/', null))).not.toThrow();
    expect(tracker.getChain(1)).toEqual(['https://example.com/']);
  });
});

// ---------------------------------------------------------------------------
// destroy() -- listener removal and state wipe
// ---------------------------------------------------------------------------

describe('NavigationTracker: destroy()', () => {
  it('is a no-op when called on a stub-mode tracker (no deps)', () => {
    const tracker = new NavigationTracker();
    expect(() => tracker.destroy()).not.toThrow();
  });

  it('stops processing onBeforeRequest events after destroy', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    // Build a chain before destroy
    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireBeforeRequest(beforeReq(1, 'https://b.com/'));
    fireCommitted(committed(1, 'https://b.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual(['https://a.com/', 'https://b.com/']);

    tracker.destroy();

    // Events fired after destroy must not be processed
    fireBeforeRequest(beforeReq(1, 'https://c.com/'));
    fireCommitted(committed(1, 'https://c.com/', ['server_redirect']));
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('stops processing onCommitted events after destroy', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    tracker.destroy();

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireCommitted(committed(1, 'https://a.com/', []));
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('stops processing onTabRemoved events after destroy', () => {
    const { deps, fireBeforeRequest, fireCommitted, fireTabRemoved } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireCommitted(committed(1, 'https://a.com/', []));
    expect(tracker.getChain(1)).toEqual(['https://a.com/']);

    tracker.destroy();

    // tabRemoved event on the destroyed tracker does nothing (chain already cleared by destroy)
    fireTabRemoved(1);
    expect(tracker.getChain(1)).toEqual([]);
  });

  it('clears all per-tab chain state on destroy', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(1, 'https://a.com/'));
    fireCommitted(committed(1, 'https://a.com/', []));
    fireBeforeRequest(beforeReq(2, 'https://b.com/'));
    fireCommitted(committed(2, 'https://b.com/', []));

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

// ---------------------------------------------------------------------------
// Realistic end-to-end sequence: affiliate redirect chain
// ---------------------------------------------------------------------------

describe('NavigationTracker: realistic affiliate redirect sequence', () => {
  it('builds a complete affiliate chain through multiple redirects', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    fireBeforeRequest(beforeReq(5, 'https://affiliate-network.com/click?id=123'));
    fireBeforeRequest(beforeReq(5, 'https://merchant.com/product'));
    fireCommitted(committed(5, 'https://merchant.com/product', ['server_redirect']));

    expect(tracker.getChain(5)).toEqual([
      'https://affiliate-network.com/click?id=123',
      'https://merchant.com/product',
    ]);
  });

  it('resets chain when user navigates away then returns', () => {
    const { deps, fireBeforeRequest, fireCommitted } = makeDeps();
    const tracker = new NavigationTracker(deps);

    // First navigation (affiliate)
    fireBeforeRequest(beforeReq(5, 'https://affiliate.com/'));
    fireBeforeRequest(beforeReq(5, 'https://merchant.com/'));
    fireCommitted(committed(5, 'https://merchant.com/', ['server_redirect']));

    // User types a new URL; fresh navigation, chain resets
    fireBeforeRequest(beforeReq(5, 'https://new-site.com/'));
    fireCommitted(committed(5, 'https://new-site.com/', []));

    expect(tracker.getChain(5)).toEqual(['https://new-site.com/']);
  });
});
