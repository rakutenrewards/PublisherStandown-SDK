import { matchesPrepared } from '../detection/matcher.js';
import type { PreparedRule } from '../detection/matcher.js';
import { NavigationTracker } from '../detection/tracker.js';
import type { TrackerDeps } from '../detection/tracker.js';
import { loadPolicies, prepareRules } from '../policies/loader.js';
import { AuditLog } from '../audit/audit-log.js';
import type {
  StanddownSDKConfig,
  DetectionResult,
  DetectionResultMatch,
  MatchedPattern,
  AffiliateEvent,
} from '../types/index.js';

/**
 * StanddownSDK: public entry point for the Standdown SDK.
 *
 * Initialise once in your background service worker; call
 * checkForAffiliatePatterns(tabId) whenever you need to decide whether to
 * stand down affiliate link injection for the active tab.
 *
 * @example
 * ```ts
 * import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';
 * const shield = new StanddownSDK();
 * const result = shield.checkForAffiliatePatterns(sender.tab.id);
 * if (result.hasAffiliatePattern) { // stand down }
 * ```
 */
export class StanddownSDK {
  private readonly preparedRules: PreparedRule[];
  private readonly tracker: NavigationTracker;
  private readonly auditLog: AuditLog | null;
  private readonly ownAffiliatePatterns: RegExp[];

  /**
   * @param config    Optional SDK configuration (user-provided policies, enableAuditLog).
   * @param tracker   Optional NavigationTracker injection for tests; supply a
   *                  pre-built tracker (with mock or real chrome deps) to bypass
   *                  automatic chrome API detection. Leave undefined in production.
   * @param auditLog  Optional AuditLog injection for test use only.
   *                  When omitted and enableAuditLog is true, the SDK creates
   *                  its own AuditLog backed by chrome.storage.local.
   *                  Ignored when enableAuditLog is false or absent.
   */
  constructor(config?: StanddownSDKConfig, tracker?: NavigationTracker, auditLog?: AuditLog) {
    this.preparedRules = prepareRules(loadPolicies(config?.policies));
    if (this.preparedRules.length === 0) {
      console.warn(
        '[StanddownSDK] No policies loaded. checkForAffiliatePatterns() will always ' +
        'return no-match. Pass one or more NetworkPolicy objects via config.policies ' +
        'to enable detection.',
      );
    }
    this.tracker = tracker ?? StanddownSDK.createTracker();
    this.auditLog = config?.enableAuditLog ? (auditLog ?? new AuditLog()) : null;
    this.ownAffiliatePatterns = config?.ownAffiliatePatterns ?? [];
  }

  /**
   * Async factory for production use.
   *
   * Creates the SDK and, when enableAuditLog is true, hydrates the in-memory
   * audit log cache from chrome.storage.local before returning. Integrators
   * who do not use enableAuditLog can continue using new StanddownSDK(config).
   *
   * @example
   * ```ts
   * const sdk = await StanddownSDK.create({ enableAuditLog: true });
   * ```
   */
  static async create(config?: StanddownSDKConfig): Promise<StanddownSDK> {
    const sdk = new StanddownSDK(config);
    if (sdk.auditLog !== null) {
      await sdk.auditLog.loadFromStorage();
    }
    return sdk;
  }

  /**
   * Inspect the URL chain observed for the given tab and return a typed
   * DetectionResult indicating whether any affiliate patterns were found.
   *
   * Detection semantics:
   * - Per URL: first matching rule wins (early exit for that URL).
   * - Across the full chain: all per-URL matches are collected in matchedPatterns.
   * - Unknown tabId: returns the empty no-match result.
   */
  checkForAffiliatePatterns(tabId: number): DetectionResult {
    const chain = this.tracker.getChain(tabId);
    const matchedPatterns: MatchedPattern[] = [];
    let maxSessionDuration = 0;

    for (const url of chain) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue; // skip malformed URLs (same behaviour as matchesRule)
      }

      for (const rule of this.preparedRules) {
        if (matchesPrepared(parsed, url, rule)) {
          matchedPatterns.push({ network: rule.networkId, rule: rule.original, url });
          if (rule.sessionDuration > maxSessionDuration) {
            maxSessionDuration = rule.sessionDuration;
          }
          break; // first match per URL wins
        }
      }
    }

    if (matchedPatterns.length === 0) {
      return {
        hasAffiliatePattern: false,
        matchedPatterns: [],
        redirectChain: chain,
        detectedAt: null,
        expiresAt: null,
        isOwnAffiliateLink: false,
      };
    }

    // matchedPatterns is non-empty here; TypeScript knows the tuple type.
    const nonEmptyPatterns = matchedPatterns as DetectionResultMatch['matchedPatterns'];

    // Evaluate own-affiliate patterns against the full redirect chain.
    // Short-circuits on: unconfigured patterns, first URL match.
    const isOwnAffiliateLink =
      this.ownAffiliatePatterns.length > 0 &&
      this.ownAffiliatePatterns.some((pattern) => chain.some((url) => pattern.test(url)));

    const now = Date.now();

    if (this.auditLog !== null) {
      this.auditLog.record({
        url: chain[chain.length - 1] ?? '',
        timestamp: now,
        sessionDuration: maxSessionDuration,
        matchedPatterns: nonEmptyPatterns,
        redirectChain: chain,
        isOwnAffiliateLink,
      });
    }

    return {
      hasAffiliatePattern: true,
      matchedPatterns: nonEmptyPatterns,
      redirectChain: chain,
      detectedAt: now,
      expiresAt: maxSessionDuration > 0 ? now + maxSessionDuration : null,
      isOwnAffiliateLink,
    };
  }

  /**
   * Return all non-expired affiliate detection events for the given URL or domain.
   *
   * Accepts a full URL or bare domain string (same normalization as `getEventLog()`).
   * Returns an empty array when no matching active session exists.
   *
   * @throws {Error} if enableAuditLog was not set to true at SDK creation.
   */
  getEventsByDomain(input: string): AffiliateEvent[] {
    if (this.auditLog === null) {
      throw new Error(
        '[StanddownSDK] getEventsByDomain() requires enableAuditLog: true. ' +
        'Pass enableAuditLog: true to StanddownSDK.create() and ensure the ' +
        '"storage" manifest permission is declared in your extension manifest.',
      );
    }
    return this.auditLog.getByDomain(input);
  }

  /**
   * Return all non-expired affiliate detection events from the audit log.
   *
   * Throws when enableAuditLog is false as intentional fail-closed behaviour.
   * An empty return would allow integrators to incorrectly infer "no active
   * session" when the log was never enabled, leading to activation when the
   * integrator should stand down.
   *
   * @throws {Error} if enableAuditLog was not set to true at SDK creation.
   */
  getEventLog(): AffiliateEvent[] {
    if (this.auditLog === null) {
      throw new Error(
        '[StanddownSDK] getEventLog() requires enableAuditLog: true. ' +
        'Pass enableAuditLog: true to StanddownSDK.create() and ensure the ' +
        '"storage" manifest permission is declared in your extension manifest.',
      );
    }
    return this.auditLog.getAll();
  }

  /**
   * Removes all browser event listeners registered by this SDK instance and
   * clears per-tab navigation state.
   *
   * Call this before discarding a StanddownSDK instance (e.g. when re-creating
   * the SDK after a config change) to prevent ghost listeners from firing
   * against stale state for the remaining lifetime of the service worker.
   */
  destroy(): void {
    this.tracker.destroy();
  }

  /**
   * Creates a NavigationTracker wired to real browser APIs when available,
   * or a stub tracker with a console warning when webNavigation is absent.
   */
  private static createTracker(): NavigationTracker {
    const deps = StanddownSDK.tryBuildDeps();
    if (deps === null) {
      console.warn(
        '[StanddownSDK] webNavigation or webRequest is not available. ' +
          'Ensure the "webNavigation", "webRequest", and "tabs" permissions are declared in your manifest. ' +
          'checkForAffiliatePatterns() will return no-match until navigation events are tracked.',
      );
      return new NavigationTracker();
    }
    return new NavigationTracker(deps);
  }

  /**
   * Attempts to build TrackerDeps from the real browser global APIs.
   *
   * Returns null if:
   * - Neither `browser` nor `chrome` is defined (e.g. Node.js / Vitest environment).
   * - webNavigation, webRequest, or tabs throw (missing manifest permissions).
   */
  private static tryBuildDeps(): TrackerDeps | null {
    try {
      const api = StanddownSDK.resolveWebExtApi();
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        onBeforeRequest: api.webRequest.onBeforeRequest as any,
        onCommitted: api.webNavigation.onCommitted,
        onTabRemoved: api.tabs.onRemoved,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolves the WebExtension API namespace for the current browser.
   *
   * Firefox exposes its extension API as `browser` (a Promise-based namespace),
   * while Chrome uses `chrome`. When running in Firefox, `globalThis.browser`
   * is defined and exposes `webNavigation`; we prefer it over `chrome` to
   * ensure event listeners are registered on the correct namespace.
   *
   * The `any` cast is intentional and necessary: `browser` is not declared in
   * @types/chrome (which only covers the `chrome` namespace), and importing a
   * separate Firefox types package would add a dependency. At runtime, if
   * `browser` looks like `chrome` (has `webNavigation`), we use it.
   */
  private static resolveWebExtApi(): typeof chrome {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
      const b = (globalThis as any).browser;
      if (b?.webNavigation) return b as typeof chrome;
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
    } catch { /* ignore */ }
    return chrome;
  }
}
