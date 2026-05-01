import type { PolicyRule } from '../types/index.js';

// ---------------------------------------------------------------------------
// PreparedRule: pre-normalised form used by the hot detection loop
// ---------------------------------------------------------------------------

/**
 * A rule flattened from its parent NetworkPolicy and pre-normalised at load
 * time so that the inner detection loop does zero per-call allocation.
 *
 * Built once by `prepareRules()` in PolicyLoader; consumed by `matchesPrepared()`
 * in `StanddownSDK.checkForAffiliatePatterns()`.
 */
export interface PreparedRule {
  /** Copied from policy.network.id to avoid re-traversing the policy tree per call. */
  networkId: string;
  /** Original PolicyRule reference, returned in MatchedPattern results. */
  original: PolicyRule;
  /**
   * Effective session duration (ms) for this rule's network.
   * Always resolved at rule-preparation time (never undefined at runtime);
   * equals the policy's sessionDuration if present, else DEFAULT_SESSION_DURATION_MS.
   */
  sessionDuration: number;
  /** Pre-lowercased domain (undefined if rule has no domain field). */
  domainLower?: string;
  /**
   * '.' + domainLower, pre-computed so the subdomain endsWith check does no
   * string concatenation at call time.
   */
  domainSuffix?: string;
  /** paths normalised to string[] once (undefined if rule has no paths field). */
  paths?: string[];
  /** params normalised to string[] once (undefined if rule has no params field). */
  params?: string[];
  /** Pre-compiled RegExp (undefined if rule has no pattern field). */
  regexp?: RegExp;
}

// ---------------------------------------------------------------------------
// matchesPrepared: hot-path matcher (production code path)
// ---------------------------------------------------------------------------

/**
 * Determines whether a URL matches a PreparedRule.
 *
 * This is the production hot path used by `StanddownSDK.checkForAffiliatePatterns()`.
 * The caller is responsible for:
 *   - Parsing `url` into `parsed` once before iterating rules.
 *   - Building PreparedRules via `prepareRules()` at SDK initialisation.
 *
 * All per-call costs are eliminated:
 *   - No URL construction (`new URL`); caller parses once per URL.
 *   - No `.toLowerCase()`; domain is pre-lowercased and URL spec guarantees
 *     parsed.hostname is already lowercase.
 *   - No `'.' + domain` string allocation; domainSuffix is pre-computed.
 *   - No `Array.isArray` / wrapping; paths and params are always arrays.
 *   - No RegExp construction; regexp is pre-compiled at load time.
 */
export function matchesPrepared(parsed: URL, url: string, rule: PreparedRule): boolean {
  // 1. domain: hostname is already lowercase per the WHATWG URL spec
  if (rule.domainLower !== undefined) {
    const hostname = parsed.hostname;
    // domainSuffix is always set when domainLower is set; invariant enforced by prepareRules() in loader.ts.
    if (hostname !== rule.domainLower && !hostname.endsWith(rule.domainSuffix!)) {
      return false;
    }
  }

  // 2. paths
  if (rule.paths !== undefined) {
    if (!rule.paths.some((p) => parsed.pathname.startsWith(p))) return false;
  }

  // 3. params
  if (rule.params !== undefined) {
    if (!rule.params.some((p) => parsed.searchParams.has(p))) return false;
  }

  // 4. pattern: pre-compiled regexp, tested against the original URL string
  if (rule.regexp !== undefined) {
    if (!rule.regexp.test(url)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// matchesRule: internal API (used by unit tests and the validate-policies script;
// not exported from src/index.ts and not part of the public SDK surface)
// ---------------------------------------------------------------------------

/**
 * Determines whether a URL matches a single PolicyRule using v2 field
 * evaluation order with short-circuit AND semantics.
 *
 * Evaluation order (cheapest first):
 *   domain → paths → params → pattern
 *
 * All present fields must match (AND). Returns false at the first failure.
 * Malformed URLs return false without throwing.
 *
 * @param regexpCache  Optional pre-compiled RegExp cache keyed by rule object
 *                     reference. When provided, the cached RegExp is used for
 *                     `pattern` evaluation instead of compiling a new instance
 *                     on every call.
 */
export function matchesRule(
  url: string,
  rule: PolicyRule,
  regexpCache?: WeakMap<PolicyRule, RegExp>,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // 1. domain: exact hostname match or subdomain match (case-insensitive)
  if (rule.domain !== undefined) {
    const domain = rule.domain.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== domain && !hostname.endsWith('.' + domain)) {
      return false;
    }
  }

  // 2. paths: pathname.startsWith any path in array (OR within field)
  if (rule.paths !== undefined) {
    const paths = Array.isArray(rule.paths) ? rule.paths : [rule.paths];
    const pathname = parsed.pathname;
    const anyPathMatches = paths.some((p) => pathname.startsWith(p));
    if (!anyPathMatches) {
      return false;
    }
  }

  // 3. params: searchParams.has any param name in array (OR within field)
  if (rule.params !== undefined) {
    const params = Array.isArray(rule.params) ? rule.params : [rule.params];
    const anyParamPresent = params.some((p) => parsed.searchParams.has(p));
    if (!anyParamPresent) {
      return false;
    }
  }

  // 4. pattern: full-URL regex match (most expensive; uses cached RegExp when
  //    the caller supplies a regexpCache).
  if (rule.pattern !== undefined) {
    const re = regexpCache?.get(rule) ?? new RegExp(rule.pattern, 'i');
    if (!re.test(url)) {
      return false;
    }
  }

  return true;
}
