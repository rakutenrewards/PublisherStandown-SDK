import type { NetworkPolicy, PolicyRule } from '../types/index.js';
import { isValidRule, isValidPolicy, SUPPORTED_SCHEMA_VERSIONS } from '../validation/policy-validator.js';
import type { PreparedRule } from '../detection/matcher.js';
import { DEFAULT_SESSION_DURATION_MS } from '../constants.js';

// ---------------------------------------------------------------------------
// Internal validation helpers
// ---------------------------------------------------------------------------

/** Validate an array of raw policies; skip invalid entries with warnings. */
function validatePolicies(raw: NetworkPolicy[]): NetworkPolicy[] {
  const result: NetworkPolicy[] = [];

  for (const policy of raw) {
    const meta = policy as unknown as Record<string, unknown>;

    if (!isValidPolicy(policy)) {
      const id = typeof meta['id'] === 'string' ? meta['id'] : 'unknown';
      console.warn(
        `[standdown-sdk] PolicyLoader: skipping invalid policy "${id}"`,
        'required fields missing or invalid: id and network.id/name must be non-empty strings; ' +
        `schemaVersion must be a supported schema version number (supported: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}); ` +
        'policyVersion must be a positive integer; rules must be an array',
      );
      continue;
    }

    // Filter rules: invalid rules are dropped, not the whole policy.
    const validRules: PolicyRule[] = [];
    for (const rule of policy.rules) {
      if (!isValidRule(rule)) {
        console.warn(
          `[standdown-sdk] PolicyLoader: skipping invalid rule in policy "${policy.id}"`,
          'each rule must have a non-empty "reason" and at least one of: domain, paths, params, pattern;' +
            ' "pattern" must not contain nested quantifiers or repeated alternation (ReDoS risk)',
        );
        continue;
      }
      validRules.push(rule);
    }

    // Preserve original rule object references so WeakMap keys remain valid.
    result.push({ ...policy, rules: validRules });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return validated affiliate network policies ready for detection.
 *
 * - **No arguments or empty array:** returns an empty array. No policies are
 *   embedded in the SDK; all policies must be supplied by the integrator.
 * - **With `userPolicies`:** validates and returns the supplied policies.
 *   - Invalid policies are skipped with `console.warn`.
 *   - Individual rules missing `reason` or any matching field are filtered out.
 *   - A policy with an empty (or fully-filtered) `rules[]` is retained as a no-op.
 *
 * Schema validation:
 * - Policies missing `id`, `version`, `network.id`, `network.name`, or `rules[]`
 *   are skipped with `console.warn`.
 * - Individual rules missing `reason` or any matching field are filtered out.
 *
 * @param userPolicies  Integrator-supplied policies. When omitted or empty,
 *                      returns an empty array.
 */
export function loadPolicies(userPolicies?: NetworkPolicy[]): NetworkPolicy[] {
  if (userPolicies === undefined || userPolicies.length === 0) {
    return [];
  }
  return validatePolicies(userPolicies);
}

/**
 * Flatten a validated policy set into a list of PreparedRules, one entry per
 * rule across all policies, pre-normalising every field so the hot detection
 * loop in `StanddownSDK.checkForAffiliatePatterns()` does zero per-call work:
 *
 * - domain lowercased + subdomain suffix pre-computed
 * - paths / params always arrays (no per-call Array.isArray / wrapping)
 * - pattern compiled to RegExp once
 * - networkId copied in so no policy-tree traversal is needed at match time
 *
 * Call once after `loadPolicies()` and store the result on the SDK instance.
 */
export function prepareRules(policies: NetworkPolicy[]): PreparedRule[] {
  const result: PreparedRule[] = [];

  for (const policy of policies) {
    for (const rule of policy.rules) {
      const domainLower = rule.domain?.toLowerCase();
      result.push({
        networkId: policy.network.id,
        original: rule,
        sessionDuration: policy.network.sessionDuration ?? DEFAULT_SESSION_DURATION_MS,
        domainLower,
        domainSuffix: domainLower !== undefined ? '.' + domainLower : undefined,
        paths:
          rule.paths !== undefined
            ? Array.isArray(rule.paths)
              ? rule.paths
              : [rule.paths]
            : undefined,
        params:
          rule.params !== undefined
            ? Array.isArray(rule.params)
              ? rule.params
              : [rule.params]
            : undefined,
        regexp: rule.pattern !== undefined ? new RegExp(rule.pattern, 'i') : undefined,
      });
    }
  }

  return result;
}

/**
 * Internal utility, not part of the public API; not re-exported from `src/index.ts`.
 *
 * Pre-compile all `pattern` fields in the validated policy set into `RegExp`
 * objects and cache them in a `WeakMap` keyed by the **same rule object
 * references** that appear in the returned `NetworkPolicy[]` array.
 *
 * Used with `matchesRule()` (also internal) so that regex construction happens
 * at load time, not on every call. The production code path uses
 * `prepareRules()` instead, which embeds compiled RegExps directly in
 * `PreparedRule` objects.
 *
 * Rules without a `pattern` field are not added to the cache; `matchesRule`
 * simply skips the regex step for those rules.
 *
 * @param policies  Validated policies returned by `loadPolicies()`.
 */
export function buildRegexpCache(policies: NetworkPolicy[]): WeakMap<PolicyRule, RegExp> {
  const cache = new WeakMap<PolicyRule, RegExp>();

  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (rule.pattern !== undefined) {
        cache.set(rule, new RegExp(rule.pattern, 'i'));
      }
    }
  }

  return cache;
}
