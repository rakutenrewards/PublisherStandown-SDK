/**
 * Core TypeScript interfaces for the Standdown SDK.
 *
 * All fields are evaluated in AND order (cheapest first):
 *   domain → paths → params → pattern
 */

/**
 * A single detection rule within a network policy.
 *
 * At least one matching field (domain, paths, params, or pattern) must be
 * present. All present fields must match (AND semantics). Fields are evaluated
 * in the order listed (cheapest first) with short-circuit on first failure.
 */
export interface PolicyRule {
  /** Hostname match. Matches exact host and all subdomains (case-insensitive). */
  domain?: string;

  /** Path prefix(es). OR semantics: any prefix match satisfies the field. */
  paths?: string | string[];

  /** Query parameter name(s). OR semantics: presence of any param satisfies the field. */
  params?: string | string[];

  /**
   * Full-URL regex (escape-hatch / value check).
   * Most expensive field; evaluated last.
   */
  pattern?: string;

  /** Required. Human-readable explanation of why this rule exists. */
  reason: string;
}

/**
 * A complete affiliate network policy containing one or more detection rules.
 */
export interface NetworkPolicy {
  /** Unique identifier for this policy (e.g. "cj", "rakuten-advertising"). */
  id: string;

  /**
   * Schema version this policy was written against (e.g. 2).
   * Only the major integer is significant; schema changes are either structural
   * (breaking) or they are not. Must be a version the SDK understands; unsupported
   * values cause the policy to be rejected at load time.
   */
  schemaVersion: number;

  /**
   * Content version of this policy's rules as a single integer.
   * Increment when detection behaviour changes substantially.
   */
  policyVersion: number;

  /** Affiliate network metadata. */
  network: {
    /** Short machine-readable network identifier. */
    id: string;
    /** Human-readable network name. */
    name: string;
    /** Optional description of the network and its detection approach. */
    description?: string;
    /**
     * How long an affiliate session for this network should be honoured, in milliseconds.
     * Optional; omit if the window is unknown or not applicable.
     * Examples: 86_400_000 (24 h, Amazon/EPN), 2_592_000_000 (30 days, Awin/Impact).
     */
    sessionDuration?: number;
  };

  /** Detection rules for this network. */
  rules: PolicyRule[];

  /** Optional freeform metadata (e.g. last-updated, source URL). */
  metadata?: Record<string, unknown>;
}

/**
 * Optional configuration passed to the StanddownSDK constructor.
 */
export interface StanddownSDKConfig {
  /**
   * Integrator-supplied affiliate network policies.
   * Each policy is validated at initialization time. Invalid policies are skipped with
   * `console.warn`. To enable detection, at least one valid policy with at least one
   * valid rule must be provided.
   */
  policies?: NetworkPolicy[];

  /**
   * When true, the SDK records each affiliate detection event to
   * chrome.storage.local and exposes getEventLog() / getEventsByDomain()
   * for querying past detections.
   *
   * Requires the "storage" manifest permission in the host extension.
   * Defaults to false; no storage access occurs when omitted.
   *
   * Use StanddownSDK.create({ enableAuditLog: true }) (async factory) in
   * production to hydrate the in-memory cache from persisted storage on startup.
   */
  enableAuditLog?: boolean;

  /**
   * Optional list of RegExp patterns identifying this extension's own publisher
   * parameters or path segments. When provided, checkForAffiliatePatterns()
   * tests every URL in the redirect chain against these patterns and sets
   * isOwnAffiliateLink on the result accordingly.
   *
   * Matching semantics:
   * - All URLs in the redirect chain are tested (not just the final URL).
   *   This handles networks that embed publisher IDs in intermediate hops
   *   (e.g. Target's goto.target.com/c/PUBLISHER_ID/ path).
   * - OR semantics: any single match across any URL sets isOwnAffiliateLink: true.
   * - isOwnAffiliateLink is only true when hasAffiliatePattern is also true.
   *
   * @example
   * ```ts
   * const sdk = new StanddownSDK({
   *   ownAffiliatePatterns: [
   *     /m_pl=YourExtension/,
   *     /[?&]m_si=12345/i,
   *     // For networks with publisher ID in an intermediate hop's path:
   *     // /goto\.target\.com\/c\/12345\//,
   *   ],
   * });
   * ```
   */
  ownAffiliatePatterns?: RegExp[];
}

/**
 * A single affiliate pattern match found within a navigation chain.
 */
export interface MatchedPattern {
  /** The network.id of the policy whose rule matched. */
  network: string;

  /** The specific rule that produced the match. */
  rule: PolicyRule;

  /** The URL in the navigation chain that triggered the match. */
  url: string;
}

/**
 * A single entry in the affiliate event audit log.
 *
 * Recorded automatically by checkForAffiliatePatterns() when enableAuditLog
 * is true and a positive detection is made. Entries are keyed by root domain
 * and overwrite previous entries for the same domain.
 */
export interface AffiliateEvent {
  /** Final landing URL of the redirect chain at time of detection. */
  url: string;

  /** Unix ms timestamp at time of detection. */
  timestamp: number;

  /**
   * standDownWindowMs from the matched network policy (longest sessionDuration
   * across all matched networks). Used to compute entry expiry:
   * timestamp + sessionDuration.
   */
  sessionDuration: number;

  /** All matched affiliate patterns from the detection result. */
  matchedPatterns: MatchedPattern[];

  /** Full redirect chain that was inspected. */
  redirectChain: string[];

  /**
   * Mirrors DetectionResult.isOwnAffiliateLink at the time this event was
   * recorded. False when ownAffiliatePatterns was not configured.
   */
  isOwnAffiliateLink: boolean;
}

/**
 * The result returned by StanddownSDK.checkForAffiliatePatterns() when at
 * least one affiliate pattern was detected in the navigation chain.
 *
 * When hasAffiliatePattern is true, matchedPatterns is guaranteed non-empty
 * and detectedAt is a number (not null). Encoding this as a discriminated
 * union lets callers safely access matchedPatterns[0] after an
 * `if (result.hasAffiliatePattern)` check without a separate length guard.
 */
export interface DetectionResultMatch {
  hasAffiliatePattern: true;

  /** All matches found across the full chain (at least one entry). */
  matchedPatterns: [MatchedPattern, ...MatchedPattern[]];

  redirectChain: string[];

  /** Unix ms timestamp at which the pattern was detected. */
  detectedAt: number;

  /**
   * Unix ms timestamp at which the stand-down session expires.
   * Computed as Date.now() + the longest sessionDuration among matched policies.
   * null when no matched policy defines a sessionDuration.
   */
  expiresAt: number | null;

  /**
   * True when at least one configured ownAffiliatePattern matches at least
   * one URL in the redirect chain.
   *
   * Always false when ownAffiliatePatterns is not configured or none match.
   */
  isOwnAffiliateLink: boolean;
}

/**
 * The result returned by StanddownSDK.checkForAffiliatePatterns() when no
 * affiliate patterns were found.
 */
export interface DetectionResultNoMatch {
  hasAffiliatePattern: false;

  /** Empty when hasAffiliatePattern is false. */
  matchedPatterns: [];

  redirectChain: string[];

  /** null when hasAffiliatePattern is false. */
  detectedAt: null;

  /** null when hasAffiliatePattern is false. */
  expiresAt: null;

  /** Always false when hasAffiliatePattern is false. */
  isOwnAffiliateLink: false;
}

/**
 * Discriminated union returned by StanddownSDK.checkForAffiliatePatterns().
 *
 * Narrow on hasAffiliatePattern to access match-specific fields safely:
 * @example
 * ```ts
 * const result = sdk.checkForAffiliatePatterns(tabId);
 * if (result.hasAffiliatePattern) {
 *   const primary = result.matchedPatterns[0]; // MatchedPattern — always defined
 * }
 * ```
 */
export type DetectionResult = DetectionResultMatch | DetectionResultNoMatch;

