// Internal validation predicates used by loader.ts (runtime).
// Not part of the public API; do not re-export from src/index.ts.

/**
 * Schema versions this SDK knows how to parse.
 * Add new versions here as the schema evolves; no other logic changes required
 * for the declaration itself.
 */
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([2]);

import type { NetworkPolicy, PolicyRule } from '../types/index.js';

/**
 * Returns true when the rule has at least one of the four matching fields.
 * A rule with only a `reason` is not a valid detection rule.
 */
function hasMatchingField(rule: PolicyRule): boolean {
  return (
    rule.domain !== undefined ||
    rule.paths !== undefined ||
    rule.params !== undefined ||
    rule.pattern !== undefined
  );
}

/**
 * Returns true when the regex pattern string is free of the most dangerous
 * catastrophic-backtracking constructs:
 * - Nested quantifiers:   a repeated group that itself contains a quantifier, e.g. (a+)+
 * - Repeated alternation: alternation inside a repeated group, e.g. (a|ab)+
 *
 * This is a conservative static check; it rejects the most common ReDoS
 * patterns without requiring a full automaton analysis.
 */
function isSafePattern(pattern: string): boolean {
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return false;
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) return false;
  return true;
}

/**
 * Returns true when the rule is safe to use for matching.
 * - `reason` must be a non-empty string.
 * - At least one matching field (domain / paths / params / pattern) must be present.
 * - `pattern`, if present, must not contain catastrophic-backtracking constructs.
 */
export function isValidRule(rule: PolicyRule): boolean {
  if (typeof rule.reason !== 'string' || rule.reason.length === 0) return false;
  if (!hasMatchingField(rule)) return false;
  if (rule.pattern !== undefined && !isSafePattern(rule.pattern)) return false;
  return true;
}

/**
 * Returns true when the top-level policy structure is present and complete.
 * Does NOT validate individual rules; those are checked separately.
 */
export function isValidPolicy(policy: NetworkPolicy): boolean {
  if (typeof policy.id !== 'string' || policy.id.length === 0) return false;
  if (typeof policy.schemaVersion !== 'number' || !Number.isInteger(policy.schemaVersion)) return false;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(policy.schemaVersion)) return false;
  if (typeof policy.policyVersion !== 'number' || !Number.isInteger(policy.policyVersion) || policy.policyVersion < 1) return false;
  if (typeof policy.network !== 'object' || policy.network === null) return false;
  if (typeof policy.network.id !== 'string' || policy.network.id.length === 0) return false;
  if (typeof policy.network.name !== 'string' || policy.network.name.length === 0) return false;
  if (!Array.isArray(policy.rules)) return false;
  if (
    policy.network.sessionDuration !== undefined &&
    (typeof policy.network.sessionDuration !== 'number' ||
      !Number.isFinite(policy.network.sessionDuration) ||
      policy.network.sessionDuration <= 0)
  ) {
    return false;
  }
  return true;
}
