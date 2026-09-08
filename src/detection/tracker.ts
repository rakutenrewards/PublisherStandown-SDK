/**
 * NavigationTracker: builds and maintains per-tab URL chains from browser
 * navigation events.
 *
 * Two mutually exclusive buffer-source modes are supported:
 * - headers mode (onHeadersReceived): used on Chrome, Firefox, and Edge.
 *   Status code drives the chain — 3xx responses buffer a redirect hop, any
 *   non-3xx response (2xx/4xx/5xx) closes the chain. Captures every
 *   intermediate HTTP hop. Requires the "webRequest" manifest permission.
 * - navigation-only mode (onBeforeNavigate + onCommitted): used on Safari,
 *   whose webRequest stubs are callable but silently drop all listeners.
 *   onBeforeNavigate captures the entry URL per navigation; onCommitted settles
 *   the chain. Intermediate server-side hops are invisible, but affiliate
 *   tracking parameters typically survive to the committed URL. Requires the
 *   "webNavigation" manifest permission.
 *
 * Injectable deps allow full unit testing without a real browser.
 * In production, StanddownSDK wires the real browser APIs into TrackerDeps.
 *
 * @example
 * ```ts
 * // Production: StanddownSDK creates with real browser APIs
 * const tracker = new NavigationTracker(realDeps);
 *
 * // Tests: inject mocks
 * const tracker = new NavigationTracker(mockDeps);
 *
 * // Stub mode: no listeners registered, getChain() always returns []
 * const tracker = new NavigationTracker();
 * ```
 */

/** Payload subset required from chrome.webRequest.onHeadersReceived. */
export interface HeadersReceivedDetails {
  tabId: number;
  url: string;
  type: string;
  statusCode: number;
}

/** Payload subset required from chrome.webNavigation.onBeforeNavigate. */
export interface BeforeNavigateDetails {
  tabId: number;
  url: string;
  frameId: number;
}

/** Payload subset required from chrome.webNavigation.onCommitted. */
export interface CommittedDetails {
  tabId: number;
  url: string;
  frameId: number;
  /** Chrome and Firefox deliver string[]. Safari delivers null (macOS) or undefined (iOS). */
  transitionQualifiers: string[] | null;
}

/**
 * Injectable chrome API subset required by NavigationTracker.
 *
 * Exactly one buffer source must be provided:
 * - onHeadersReceived (headers mode): preferred on Chrome/Firefox/Edge; captures
 *   all intermediate HTTP hops via status codes. Requires the "webRequest" permission.
 * - onBeforeNavigate + onCommitted (navigation-only mode): used on Safari, where
 *   webRequest is non-functional. Captures the initiating URL per navigation and
 *   settles the chain on commit. Requires the "webNavigation" permission.
 *
 * webNavigation is therefore optional: Chrome/Firefox/Edge integrations do not
 * need to declare it, and the SDK never touches it on those browsers.
 */
export interface TrackerDeps {
  onHeadersReceived?: {
    addListener(
      callback: (details: HeadersReceivedDetails) => void,
      filter: { urls: string[]; types: string[] },
    ): void;
    removeListener(callback: (details: HeadersReceivedDetails) => void): void;
  };
  onBeforeNavigate?: {
    addListener(callback: (details: BeforeNavigateDetails) => void): void;
    removeListener(callback: (details: BeforeNavigateDetails) => void): void;
  };
  onCommitted?: {
    addListener(callback: (details: CommittedDetails) => void): void;
    removeListener(callback: (details: CommittedDetails) => void): void;
  };
  onTabRemoved: {
    addListener(callback: (tabId: number) => void): void;
    removeListener(callback: (tabId: number) => void): void;
  };
}

/**
 * Builds and maintains per-tab URL chains from browser navigation events.
 *
 * See the module header for the two supported modes (headers vs navigation-only)
 * and their platform mapping.
 */
export class NavigationTracker {
  private readonly tabChains: Map<number, string[]> = new Map();
  private readonly tabRequestBuffers: Map<number, string[]> = new Map();
  private readonly deps: TrackerDeps | undefined;
  private readonly onHeadersReceivedHandler:
    | ((details: HeadersReceivedDetails) => void)
    | undefined;
  private readonly onBeforeNavigateHandler: ((details: BeforeNavigateDetails) => void) | undefined;
  private readonly onCommittedHandler: ((details: CommittedDetails) => void) | undefined;
  private readonly onTabRemovedHandler: ((tabId: number) => void) | undefined;

  /**
   * @param deps  Chrome API event references for testability.
   *              When omitted, no listeners are registered and getChain()
   *              always returns [] (stub mode for backward compatibility).
   */
  constructor(deps?: TrackerDeps) {
    if (deps === undefined) return;

    this.deps = deps;

    if (deps.onHeadersReceived !== undefined) {
      // ---- headers mode (Chrome / Firefox / Edge) ---------------------------
      this.onHeadersReceivedHandler = ({ tabId, url, type, statusCode }) => {
        if (type !== 'main_frame') return;
        if (tabId < 0) return;

        if (statusCode >= 300 && statusCode <= 399) {
          const buf = this.tabRequestBuffers.get(tabId);
          if (buf !== undefined) {
            buf.push(url);
          } else {
            this.tabRequestBuffers.set(tabId, [url]);
          }
          return;
        }

        const buf = this.tabRequestBuffers.get(tabId);
        if (buf === undefined) {
          this.tabChains.set(tabId, [url]);
          return;
        }

        this.tabChains.set(tabId, this.dedupeWithCommitted(buf, url));
        this.tabRequestBuffers.delete(tabId);
      };
      deps.onHeadersReceived.addListener(
        this.onHeadersReceivedHandler,
        { urls: ['<all_urls>'], types: ['main_frame'] },
      );
    } else if (deps.onBeforeNavigate !== undefined && deps.onCommitted !== undefined) {
      // ---- navigation-only mode (Safari) ------------------------------------
      this.onBeforeNavigateHandler = ({ tabId, url, frameId }) => {
        if (frameId !== 0) return;
        if (tabId < 0) return;
        const buf = this.tabRequestBuffers.get(tabId);
        if (buf !== undefined) {
          buf.push(url);
        } else {
          this.tabRequestBuffers.set(tabId, [url]);
        }
      };
      deps.onBeforeNavigate.addListener(this.onBeforeNavigateHandler);

      this.onCommittedHandler = ({ tabId, url, frameId, transitionQualifiers }) => {
        if (frameId !== 0) return;

        const qualifiers = transitionQualifiers ?? [];
        const isRedirectByQualifier =
          qualifiers.includes('server_redirect') ||
          qualifiers.includes('client_redirect') ||
          qualifiers.includes('redirect');

        const buf = this.tabRequestBuffers.get(tabId);

        // Safari: qualifiers are null or undefined (iOS delivers undefined, macOS null).
        // If the buffered URL differs from the committed URL, a server-side redirect
        // occurred — the buffered URL was the entry point and the committed URL is where
        // it resolved. Equal URLs indicate direct navigation with no redirect.
        // Loose equality (== null) matches both null and undefined; gated on nullish
        // specifically so this path never activates on Chrome or Firefox (string[]).
        const isRedirectBySafariHeuristic =
          transitionQualifiers == null &&
          buf !== undefined &&
          buf.length > 0 &&
          buf[buf.length - 1] !== url;

        if (!isRedirectByQualifier && !isRedirectBySafariHeuristic) {
          this.tabRequestBuffers.delete(tabId);
          this.tabChains.set(tabId, [url]);
        } else {
          this.tabChains.set(tabId, this.dedupeWithCommitted(buf ?? [], url));
          this.tabRequestBuffers.delete(tabId);
        }
      };
      deps.onCommitted.addListener(this.onCommittedHandler);
    }

    this.onTabRemovedHandler = (tabId) => {
      this.tabChains.delete(tabId);
      this.tabRequestBuffers.delete(tabId);
    };

    deps.onTabRemoved.addListener(this.onTabRemovedHandler);
  }

  /**
   * Deduplicates the buffered hops in insertion order and appends the committed
   * URL if not already present. Shared by both buffer-source modes.
   */
  private dedupeWithCommitted(buffer: string[], committedUrl: string): string[] {
    const seen = new Set<string>();
    const chain: string[] = [];
    for (const u of buffer) {
      if (!seen.has(u)) { seen.add(u); chain.push(u); }
    }
    if (!seen.has(committedUrl)) chain.push(committedUrl);
    return chain;
  }

  /**
   * Returns the current URL chain for the given tab.
   * Returns [] if the tab is unknown or no navigation has been observed.
   */
  getChain(tabId: number): string[] {
    return this.tabChains.get(tabId) ?? [];
  }

  /**
   * Removes all registered browser event listeners and clears per-tab state.
   *
   * Call this when discarding a StanddownSDK instance to prevent ghost listeners
   * from firing against stale state for the lifetime of the service worker.
   * No-op when the tracker was constructed in stub mode (no deps).
   */
  destroy(): void {
    if (this.deps === undefined || this.onTabRemovedHandler === undefined) return;

    if (this.onHeadersReceivedHandler !== undefined) {
      this.deps.onHeadersReceived!.removeListener(this.onHeadersReceivedHandler);
    }
    if (this.onBeforeNavigateHandler !== undefined) {
      this.deps.onBeforeNavigate!.removeListener(this.onBeforeNavigateHandler);
    }
    if (this.onCommittedHandler !== undefined) {
      this.deps.onCommitted!.removeListener(this.onCommittedHandler);
    }
    this.deps.onTabRemoved.removeListener(this.onTabRemovedHandler);
    this.tabChains.clear();
    this.tabRequestBuffers.clear();
  }
}
