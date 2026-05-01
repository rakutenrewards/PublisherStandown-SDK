import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesRule } from '../../src/detection/matcher.js';
import { buildRegexpCache, loadPolicies, prepareRules } from '../../src/policies/loader.js';
import type { NetworkPolicy, PolicyRule } from '../../src/types/index.js';
import { DEFAULT_SESSION_DURATION_MS } from '../../src/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(
  overrides: Partial<NetworkPolicy> = {},
  networkOverrides: Partial<NetworkPolicy['network']> = {},
): NetworkPolicy {
  return {
    id: 'test-network',
    schemaVersion: 2,
    policyVersion: 2,
    network: { id: 'test', name: 'Test Network', ...overrides.network, ...networkOverrides },
    rules: [
      { domain: 'example.com', reason: 'test rule' },
    ],
    ...overrides,
  };
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return { domain: 'example.com', reason: 'test rule', ...overrides };
}

/** Find a policy by id in the merged result; throws if not found. */
function findById(policies: NetworkPolicy[], id: string): NetworkPolicy {
  const p = policies.find((pol) => pol.id === id);
  if (p === undefined) throw new Error(`Policy "${id}" not found in result`);
  return p;
}

// ---------------------------------------------------------------------------
// loadPolicies: no-arg and empty-array behavior (post-removal)
// ---------------------------------------------------------------------------

describe('loadPolicies: no-arg and empty-array behavior', () => {
  it('returns [] when called with no arguments', () => {
    expect(loadPolicies()).toHaveLength(0);
  });

  it('returns [] when called with an empty array', () => {
    expect(loadPolicies([])).toHaveLength(0);
  });

  it('returns [] and warns when all supplied policies are invalid', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = makePolicy({ id: '' });
    expect(loadPolicies([bad as unknown as NetworkPolicy])).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: user policy merging: append new network
// ---------------------------------------------------------------------------

describe('loadPolicies: user policy merging: append new network', () => {
  it('returns a single policy when one valid user policy is supplied', () => {
    const policy = makePolicy();
    const result = loadPolicies([policy]);
    expect(result).toHaveLength(1);
    expect(findById(result, 'test-network').id).toBe('test-network');
  });

  it('returns two policies when two valid user policies are supplied', () => {
    const p1 = makePolicy({ id: 'net-a' });
    const p2 = makePolicy({ id: 'net-b' });
    const result = loadPolicies([p1, p2]);
    expect(result).toHaveLength(2);
    expect(findById(result, 'net-a').id).toBe('net-a');
    expect(findById(result, 'net-b').id).toBe('net-b');
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: user policy merging: metadata and rules
// ---------------------------------------------------------------------------

describe('loadPolicies: user policy merging: metadata and rules', () => {
  it('accepts a user policy with an empty rules array (valid no-op)', () => {
    const policy = makePolicy({ rules: [] });
    const result = loadPolicies([policy]);
    expect(result).toHaveLength(1);
    expect(findById(result, 'test-network').rules).toHaveLength(0);
  });

  it('preserves metadata of user policy in the result', () => {
    const policy = makePolicy({ metadata: { source: 'manual', updated: '2026-01-01' } });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').metadata?.['source']).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: invalid user policies are skipped; valid ones are returned
// ---------------------------------------------------------------------------

describe('loadPolicies: invalid user policies are skipped', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('skips an invalid user policy and returns [] (no valid policies remain)', () => {
    const bad = makePolicy({ id: '' });
    const result = loadPolicies([bad as unknown as NetworkPolicy]);
    expect(result).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('returns 1 when mix of valid + invalid user policies (invalid skipped)', () => {
    const good = makePolicy({ id: 'good-network' });
    const bad = makePolicy({ id: '' });
    const result = loadPolicies([good, bad as unknown as NetworkPolicy]);
    expect(result).toHaveLength(1);
    expect(findById(result, 'good-network').id).toBe('good-network');
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: top-level validation: missing required fields
// ---------------------------------------------------------------------------

describe('loadPolicies: top-level validation: missing required fields', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('skips a policy with no id and warns', () => {
    const policy = makePolicy({ id: '' });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with a missing id field and warns', () => {
    const { id: _id, ...noId } = makePolicy();
    expect(loadPolicies([noId as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with a missing policyVersion and warns', () => {
    const { policyVersion: _pv, ...noPolicyVersion } = makePolicy();
    expect(loadPolicies([noPolicyVersion as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with a non-integer policyVersion (string) and warns', () => {
    const policy = makePolicy({ policyVersion: '2' as unknown as number });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with a float policyVersion and warns', () => {
    const policy = makePolicy({ policyVersion: 2.5 });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with a zero policyVersion and warns', () => {
    const policy = makePolicy({ policyVersion: 0 });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('accepts a policy with policyVersion 1', () => {
    const policy = makePolicy({ id: 'pv-test-1', policyVersion: 1 });
    expect(loadPolicies([policy])).toHaveLength(1);
  });

  it('accepts a policy with policyVersion 2', () => {
    const policy = makePolicy({ id: 'pv-test-2', policyVersion: 2 });
    expect(loadPolicies([policy])).toHaveLength(1);
  });

  it('accepts a policy with a high policyVersion', () => {
    const policy = makePolicy({ id: 'pv-test-3', policyVersion: 100 });
    expect(loadPolicies([policy])).toHaveLength(1);
  });

  it('skips a policy with a string schemaVersion and warns', () => {
    const policy = makePolicy({ schemaVersion: '2' as unknown as number });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with missing schemaVersion and warns', () => {
    const { schemaVersion: _sv, ...noSchemaVersion } = makePolicy();
    expect(loadPolicies([noSchemaVersion as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with an unsupported schemaVersion and warns', () => {
    // 1 is the old schema version; no longer supported
    const policy = makePolicy({ schemaVersion: 1 });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with an unrecognised schemaVersion and warns', () => {
    const policy = makePolicy({ schemaVersion: 99 });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('accepts a policy with the supported schemaVersion', () => {
    const policy = makePolicy({ id: 'supported-schema-test', schemaVersion: 2 });
    expect(loadPolicies([policy])).toHaveLength(1);
  });

  it('skips a policy with a null network and warns', () => {
    const policy = { ...makePolicy(), network: null };
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with an empty network.id and warns', () => {
    const policy = makePolicy({ network: { id: '', name: 'Test' } });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy with an empty network.name and warns', () => {
    const policy = makePolicy({ network: { id: 'test', name: '' } });
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a policy where rules is not an array and warns', () => {
    const policy = { ...makePolicy(), rules: 'not-an-array' };
    expect(loadPolicies([policy as unknown as NetworkPolicy])).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('returns [] when all user policies are invalid', () => {
    const p1 = makePolicy({ id: '' });
    const p2 = makePolicy({ policyVersion: 0 });
    expect(
      loadPolicies([p1 as unknown as NetworkPolicy, p2 as unknown as NetworkPolicy]),
    ).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: rule-level validation
// ---------------------------------------------------------------------------

describe('loadPolicies: rule-level validation', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('skips a rule missing reason and warns', () => {
    const policy = makePolicy({
      rules: [
        { domain: 'example.com', reason: '' } as unknown as PolicyRule,
      ],
    });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('skips a rule with no matching fields (only reason present) and warns', () => {
    const policy = makePolicy({
      rules: [{ reason: 'no matching fields' } as PolicyRule],
    });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('keeps valid rules and filters invalid ones from the same policy', () => {
    const policy = makePolicy({
      rules: [
        { domain: 'good.com', reason: 'valid rule' },
        { reason: 'missing matching field' } as PolicyRule,
        { params: 'afsrc', reason: 'also valid' },
      ],
    });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').rules).toHaveLength(2);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('retains the policy (with filtered rules) when all rules are invalid', () => {
    const policy = makePolicy({
      rules: [{ reason: 'no fields' } as PolicyRule],
    });
    const result = loadPolicies([policy]);
    // Policy itself is valid; it just has no usable rules, still included
    expect(findById(result, 'test-network').rules).toHaveLength(0);
  });

  it('accepts rules with only a pattern field (no domain/paths/params)', () => {
    const policy = makePolicy({
      rules: [{ pattern: 'afsrc=\\d', reason: 'pattern-only rule' }],
    });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').rules).toHaveLength(1);
  });

  it('accepts rules with only paths field', () => {
    const policy = makePolicy({
      rules: [{ paths: '/click', reason: 'paths-only' }],
    });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').rules).toHaveLength(1);
  });

  it('accepts rules with only params field', () => {
    const policy = makePolicy({
      rules: [{ params: 'afsrc', reason: 'params-only' }],
    });
    const result = loadPolicies([policy]);
    expect(findById(result, 'test-network').rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: rule-level validation: ReDoS pattern safety
// ---------------------------------------------------------------------------

describe('loadPolicies: ReDoS pattern safety', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  // Safe patterns: must be accepted
  it('accepts a safe pattern with no quantifiers', () => {
    const policy = makePolicy({ rules: [{ pattern: 'click\\.example\\.com', reason: 'safe' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('accepts a safe pattern with a simple bounded quantifier', () => {
    const policy = makePolicy({ rules: [{ pattern: 'i[0-9]{6}\\.net', reason: 'safe bounded' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('accepts a safe pattern with a top-level + quantifier (no nesting)', () => {
    const policy = makePolicy({ rules: [{ pattern: 'click-\\d+', reason: 'safe top-level +' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  // Nested quantifiers: must be rejected
  it('rejects a pattern with nested quantifiers (a+)+ and warns', () => {
    const policy = makePolicy({ rules: [{ pattern: '(a+)+b', reason: 'redos' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('rejects a pattern with nested quantifiers (a*)* and warns', () => {
    const policy = makePolicy({ rules: [{ pattern: '(a*)*b', reason: 'redos star-star' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('rejects a pattern with nested quantifiers (a+)* and warns', () => {
    const policy = makePolicy({ rules: [{ pattern: '(a+)*b', reason: 'redos plus-star' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  // Repeated alternation: must be rejected
  it('rejects a pattern with alternation inside a repeated group (a|ab)+ and warns', () => {
    const policy = makePolicy({ rules: [{ pattern: '(a|ab)+', reason: 'redos alternation' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('rejects a pattern with alternation inside a repeated group (x+x+)+y and warns', () => {
    const policy = makePolicy({ rules: [{ pattern: '(x+x+)+y', reason: 'redos nested plus' }] });
    expect(findById(loadPolicies([policy]), 'test-network').rules).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  // Mixed rules: safe ones kept, unsafe ones filtered
  it('keeps safe rules and drops unsafe ones from the same policy', () => {
    const policy = makePolicy({
      rules: [
        { pattern: 'click-\\d+', reason: 'safe' },
        { pattern: '(a+)+b', reason: 'redos' },
        { domain: 'example.com', reason: 'domain rule, safe' },
      ],
    });
    const result = findById(loadPolicies([policy]), 'test-network');
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0]?.pattern).toBe('click-\\d+');
    expect(result.rules[1]?.domain).toBe('example.com');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  // Warn message content
  it('warn message mentions ReDoS risk', () => {
    const policy = makePolicy({ rules: [{ pattern: '(a+)+b', reason: 'redos' }] });
    loadPolicies([policy]);
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.join(' ')).toMatch(/redos/i);
  });
});

// ---------------------------------------------------------------------------
// buildRegexpCache: cache construction
// ---------------------------------------------------------------------------

describe('buildRegexpCache: cache construction', () => {
  it('does not cache a rule with no pattern field', () => {
    const rule: PolicyRule = { domain: 'example.com', reason: 'no pattern' };
    const cache = buildRegexpCache([makePolicy({ rules: [rule] })]);
    expect(cache.has(rule)).toBe(false);
  });

  it('adds a RegExp entry for each rule with a pattern field', () => {
    const rule: PolicyRule = { pattern: 'click-\\d+', reason: 'click rule' };
    const cache = buildRegexpCache([makePolicy({ rules: [rule] })]);
    expect(cache.has(rule)).toBe(true);
    expect(cache.get(rule)).toBeInstanceOf(RegExp);
  });

  it('compiles the pattern with the case-insensitive flag', () => {
    const rule: PolicyRule = { pattern: 'example', reason: 'test' };
    const cache = buildRegexpCache([makePolicy({ rules: [rule] })]);
    expect(cache.get(rule)!.flags).toContain('i');
  });

  it('builds cache entries for multiple rules across multiple policies', () => {
    const r1: PolicyRule = { pattern: 'foo', reason: 'r1' };
    const r2: PolicyRule = { domain: 'bar.com', reason: 'r2' };
    const r3: PolicyRule = { pattern: 'baz', reason: 'r3' };
    const p1 = makePolicy({ id: 'p1', rules: [r1, r2] });
    const p2 = makePolicy({ id: 'p2', rules: [r3] });
    const cache = buildRegexpCache([p1, p2]);

    expect(cache.has(r1)).toBe(true);   // has pattern
    expect(cache.has(r2)).toBe(false);  // no pattern
    expect(cache.has(r3)).toBe(true);   // has pattern
  });

  it('returns an empty WeakMap when passed an empty array', () => {
    const cache = buildRegexpCache([]);
    expect(cache).toBeInstanceOf(WeakMap);
  });
});

describe('buildRegexpCache: cache is used at match time, not recompiled per call', () => {
  /**
   * Proof that matchesRule uses the cached RegExp and does NOT recompile:
   * After building the cache, mutate the rule's `pattern` string.
   * If matchesRule recompiles using rule.pattern, it would use the new (wrong)
   * pattern. If it uses the cache, it still uses the original compiled RegExp.
   */
  it('matchesRule uses the cached RegExp, not the current rule.pattern string', () => {
    const rule: PolicyRule = { pattern: 'click-\\d+', reason: 'CJ click' };
    const cache = buildRegexpCache([makePolicy({ rules: [rule] })]);

    // Mutate the pattern AFTER caching; the cached RegExp should still match.
    (rule as unknown as Record<string, unknown>)['pattern'] = 'WILL-NEVER-MATCH-ANYTHING';

    // Should still match because the cache has the original compiled /click-\d+/i
    expect(matchesRule('https://dpbolvw.net/click-123456', rule, cache)).toBe(true);

    // Calling WITHOUT the cache now uses the mutated pattern → no match
    expect(matchesRule('https://dpbolvw.net/click-123456', rule)).toBe(false);
  });

  it('matchesRule falls back to compiling rule.pattern when no cache is provided', () => {
    const rule = makeRule({ pattern: 'click-\\d+' });
    expect(matchesRule('https://example.com/click-99', rule)).toBe(true);
    expect(matchesRule('https://example.com/other', rule)).toBe(false);
  });

  it('matchesRule with cache matches correctly for valid pattern', () => {
    const rule: PolicyRule = { pattern: 'afsrc=1', reason: 'standdown param' };
    const cache = buildRegexpCache([makePolicy({ rules: [rule] })]);

    expect(matchesRule('https://merchant.com/?afsrc=1&product=abc', rule, cache)).toBe(true);
    expect(matchesRule('https://merchant.com/?other=1', rule, cache)).toBe(false);
  });

  it('matchesRule with cache is case-insensitive (RegExp compiled with /i)', () => {
    const rule: PolicyRule = { pattern: 'example\\.com', reason: 'domain check' };
    const cache = buildRegexpCache([makePolicy({ rules: [rule] })]);

    expect(matchesRule('https://EXAMPLE.COM/path', rule, cache)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadPolicies: rule object references are preserved
// ---------------------------------------------------------------------------

describe('loadPolicies: rule object references are preserved', () => {
  it('valid rule in output is the same object reference as in input', () => {
    const inputRule: PolicyRule = { domain: 'example.com', reason: 'preserved ref' };
    const policy = makePolicy({ rules: [inputRule] });
    const result = loadPolicies([policy]);
    // Same reference; important for WeakMap cache keying
    expect(findById(result, 'test-network').rules[0]).toBe(inputRule);
  });
});

// ---------------------------------------------------------------------------
// prepareRules: sessionDuration resolution
// ---------------------------------------------------------------------------

describe('prepareRules: sessionDuration resolution', () => {
  it('carries the policy sessionDuration to each prepared rule', () => {
    const policy = makePolicy({}, { sessionDuration: 7_200_000 });
    const rules = prepareRules([policy]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.sessionDuration).toBe(7_200_000);
  });

  it('falls back to DEFAULT_SESSION_DURATION_MS when sessionDuration is absent', () => {
    const policy = makePolicy(); // no sessionDuration
    const rules = prepareRules([policy]);
    expect(rules[0]?.sessionDuration).toBe(DEFAULT_SESSION_DURATION_MS);
  });

  it('applies the resolved sessionDuration to every rule in the policy', () => {
    const policy = makePolicy(
      { rules: [{ domain: 'a.example.com', reason: 'rule 1' }, { params: 'afsrc', reason: 'rule 2' }] },
      { sessionDuration: 3_600_000 },
    );
    const rules = prepareRules([policy]);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.sessionDuration).toBe(3_600_000);
    expect(rules[1]?.sessionDuration).toBe(3_600_000);
  });

  it('resolves sessionDuration independently per policy in a multi-policy set', () => {
    const p1 = makePolicy({ id: 'net-a' }, { sessionDuration: 1_800_000 });
    const p2 = makePolicy({ id: 'net-b' }); // no sessionDuration → default
    const rules = prepareRules([p1, p2]);
    expect(rules[0]?.sessionDuration).toBe(1_800_000);
    expect(rules[1]?.sessionDuration).toBe(DEFAULT_SESSION_DURATION_MS);
  });

  it('prepareRules produces correct sessionDuration from an explicit policy fixture', () => {
    const policy = makePolicy({ id: 'duration-test' }, { sessionDuration: 1_800_000 });
    const rules = prepareRules([policy]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.sessionDuration).toBe(1_800_000);
    }
  });
});
