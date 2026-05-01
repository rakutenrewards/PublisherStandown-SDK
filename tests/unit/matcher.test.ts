import { describe, expect, it } from 'vitest';
import { matchesRule, matchesPrepared } from '../../src/detection/matcher.js';
import type { PreparedRule } from '../../src/detection/matcher.js';
import type { PolicyRule } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rule(overrides: Partial<PolicyRule>): PolicyRule {
  return { reason: 'test', ...overrides };
}

// ---------------------------------------------------------------------------
// Malformed URL
// ---------------------------------------------------------------------------

describe('matchesRule: malformed URL', () => {
  it('returns false for a non-URL string', () => {
    expect(matchesRule('not-a-url', rule({ domain: 'example.com' }))).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(matchesRule('', rule({ domain: 'example.com' }))).toBe(false);
  });

  it('returns false for a relative path', () => {
    expect(matchesRule('/some/path?q=1', rule({ params: 'q' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// domain field
// ---------------------------------------------------------------------------

describe('matchesRule: domain field', () => {
  it('matches exact hostname', () => {
    expect(matchesRule('https://example.com/path', rule({ domain: 'example.com' }))).toBe(true);
  });

  it('matches subdomain of domain', () => {
    expect(matchesRule('https://rover.ebay.com/path', rule({ domain: 'ebay.com' }))).toBe(true);
  });

  it('matches deep subdomain', () => {
    expect(
      matchesRule('https://a.b.affiliate.com/click', rule({ domain: 'affiliate.com' })),
    ).toBe(true);
  });

  it('does not match a different domain', () => {
    expect(matchesRule('https://evil.com/path', rule({ domain: 'example.com' }))).toBe(false);
  });

  it('does not match a domain that contains the target as a suffix but is not a subdomain', () => {
    // "notexample.com" should NOT match domain "example.com"
    expect(matchesRule('https://notexample.com/path', rule({ domain: 'example.com' }))).toBe(false);
  });

  it('is case-insensitive for the hostname', () => {
    expect(matchesRule('https://ROVER.EBAY.COM/path', rule({ domain: 'ebay.com' }))).toBe(true);
  });

  it('is case-insensitive for the domain rule value', () => {
    expect(matchesRule('https://rover.ebay.com/path', rule({ domain: 'EBAY.COM' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// paths field
// ---------------------------------------------------------------------------

describe('matchesRule: paths field (string)', () => {
  it('matches when pathname starts with the given path (string)', () => {
    expect(
      matchesRule('https://example.com/click/123', rule({ paths: '/click' })),
    ).toBe(true);
  });

  it('does not match when pathname does not start with the path', () => {
    expect(matchesRule('https://example.com/other', rule({ paths: '/click' }))).toBe(false);
  });
});

describe('matchesRule: paths field (array, OR semantics)', () => {
  it('matches when pathname starts with any path in the array', () => {
    expect(
      matchesRule(
        'https://example.com/redirect/go',
        rule({ paths: ['/click', '/redirect'] }),
      ),
    ).toBe(true);
  });

  it('matches when pathname starts with the first path in the array', () => {
    expect(
      matchesRule(
        'https://example.com/click/go',
        rule({ paths: ['/click', '/redirect'] }),
      ),
    ).toBe(true);
  });

  it('does not match when pathname starts with none of the paths', () => {
    expect(
      matchesRule(
        'https://example.com/other/page',
        rule({ paths: ['/click', '/redirect'] }),
      ),
    ).toBe(false);
  });

  it('handles an empty array as no match (no path satisfies startsWith)', () => {
    expect(matchesRule('https://example.com/click', rule({ paths: [] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// params field
// ---------------------------------------------------------------------------

describe('matchesRule: params field (string)', () => {
  it('matches when the query string contains the param', () => {
    expect(matchesRule('https://example.com/?afsrc=1', rule({ params: 'afsrc' }))).toBe(true);
  });

  it('does not match when the param is absent', () => {
    expect(matchesRule('https://example.com/?other=1', rule({ params: 'afsrc' }))).toBe(false);
  });
});

describe('matchesRule: params field (array, OR semantics)', () => {
  it('matches when any listed param is present', () => {
    expect(
      matchesRule(
        'https://example.com/?affsource=cj',
        rule({ params: ['afsrc', 'affsource'] }),
      ),
    ).toBe(true);
  });

  it('matches when the first listed param is present', () => {
    expect(
      matchesRule('https://example.com/?afsrc=1', rule({ params: ['afsrc', 'affsource'] })),
    ).toBe(true);
  });

  it('does not match when none of the listed params are present', () => {
    expect(
      matchesRule(
        'https://example.com/?unrelated=1',
        rule({ params: ['afsrc', 'affsource'] }),
      ),
    ).toBe(false);
  });

  it('handles an empty array as no match', () => {
    expect(matchesRule('https://example.com/?afsrc=1', rule({ params: [] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pattern field
// ---------------------------------------------------------------------------

describe('matchesRule: pattern field', () => {
  it('matches when the regex matches the full URL', () => {
    expect(
      matchesRule(
        'https://dpbolvw.net/click-123456-789',
        rule({ pattern: 'dpbolvw\\.net/click-\\d+' }),
      ),
    ).toBe(true);
  });

  it('does not match when the regex does not match', () => {
    expect(
      matchesRule(
        'https://example.com/other',
        rule({ pattern: 'dpbolvw\\.net/click-\\d+' }),
      ),
    ).toBe(false);
  });

  it('is case-insensitive (RegExp compiled with /i flag)', () => {
    expect(
      matchesRule('https://EXAMPLE.COM/path', rule({ pattern: 'example\\.com' })),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AND semantics: combined fields, short-circuit on first failure
// ---------------------------------------------------------------------------

describe('matchesRule: AND semantics', () => {
  it('matches when domain + params both match', () => {
    expect(
      matchesRule(
        'https://example.com/?afsrc=1',
        rule({ domain: 'example.com', params: 'afsrc' }),
      ),
    ).toBe(true);
  });

  it('fails when domain matches but params does not', () => {
    expect(
      matchesRule(
        'https://example.com/?other=1',
        rule({ domain: 'example.com', params: 'afsrc' }),
      ),
    ).toBe(false);
  });

  it('fails when params matches but domain does not', () => {
    expect(
      matchesRule(
        'https://evil.com/?afsrc=1',
        rule({ domain: 'example.com', params: 'afsrc' }),
      ),
    ).toBe(false);
  });

  it('matches when domain + paths both match', () => {
    expect(
      matchesRule(
        'https://example.com/click/go',
        rule({ domain: 'example.com', paths: '/click' }),
      ),
    ).toBe(true);
  });

  it('fails when domain matches but paths does not', () => {
    expect(
      matchesRule(
        'https://example.com/other',
        rule({ domain: 'example.com', paths: '/click' }),
      ),
    ).toBe(false);
  });

  it('matches when domain + paths + pattern all match', () => {
    expect(
      matchesRule(
        'https://dpbolvw.net/click-123456',
        rule({
          domain: 'dpbolvw.net',
          paths: '/click',
          pattern: 'click-\\d+',
        }),
      ),
    ).toBe(true);
  });

  it('fails on domain: skips paths and pattern evaluation (short-circuit)', () => {
    // domain fails so paths/pattern never evaluated; result is false
    expect(
      matchesRule(
        'https://evil.com/click-123456',
        rule({
          domain: 'dpbolvw.net',
          paths: '/click',
          pattern: 'click-\\d+',
        }),
      ),
    ).toBe(false);
  });

  it('fails on paths: skips params and pattern evaluation', () => {
    expect(
      matchesRule(
        'https://dpbolvw.net/other?afsrc=1',
        rule({
          domain: 'dpbolvw.net',
          paths: '/click',
          params: 'afsrc',
        }),
      ),
    ).toBe(false);
  });

  it('fails on params: skips pattern evaluation', () => {
    expect(
      matchesRule(
        'https://dpbolvw.net/click?unrelated=1',
        rule({
          domain: 'dpbolvw.net',
          paths: '/click',
          params: 'afsrc',
          pattern: 'dpbolvw',
        }),
      ),
    ).toBe(false);
  });

  it('returns true when all four fields match', () => {
    expect(
      matchesRule(
        'https://dpbolvw.net/click?afsrc=1&extra=x',
        rule({
          domain: 'dpbolvw.net',
          paths: '/click',
          params: 'afsrc',
          pattern: 'afsrc=1',
        }),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule with no optional fields (only reason): vacuously true
// ---------------------------------------------------------------------------

describe('matchesRule: rule with no matching fields', () => {
  it('returns true when no optional fields are present (reason-only rule)', () => {
    // All optional fields absent means no constraints → match
    expect(matchesRule('https://any-valid-url.com/', rule({}))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Performance: NFR-1 / FR-3: matching decision < 1ms for 1000+ rules
// ---------------------------------------------------------------------------

/**
 * Runs `fn` `repetitions` times and returns the median elapsed time in ms.
 * Using the median (not min or mean) gives a stable signal:
 *   - min is fragile: one warm cache hit makes it unrealistically fast
 *   - mean is skewed by occasional GC pauses
 *   - median reflects the typical steady-state cost
 */
function medianMs(fn: () => void, repetitions = 51): number {
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  // samples is non-empty (repetitions >= 1), so the mid index always exists
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

describe('matchesPrepared: performance (NFR-1 / FR-3, production code path)', () => {
  /**
   * Worst-case scan: 1000 domain-only PreparedRules, none matching the probe
   * URL. No early exit fires; every rule is fully evaluated.
   *
   * This mirrors the actual production hot path in
   * StanddownSDK.checkForAffiliatePatterns(): URL parsed once, then
   * matchesPrepared() called per rule.
   *
   * Threshold: 1ms, matches the NFR-1 / FR-3 spec target directly.
   * Observed median on a dev machine is ~0.03ms, giving ~30× headroom.
   */
  it('scans 1000 non-matching domain PreparedRules in < 1ms (median over 51 runs)', () => {
    const prepared: PreparedRule[] = Array.from({ length: 1000 }, (_, i) => {
      const domainLower = `network${i}.example.com`;
      return {
        networkId: 'test',
        original: rule({ domain: domainLower }),
        sessionDuration: 86_400_000,
        domainLower,
        domainSuffix: '.' + domainLower,
      };
    });

    const probeUrl = 'https://no-match-at-all.com/page?q=1';
    const parsedProbe = new URL(probeUrl);

    const median = medianMs(() => {
      for (const r of prepared) matchesPrepared(parsedProbe, probeUrl, r);
    });

    console.log(`[perf] 1000-rule domain scan (matchesPrepared) median: ${median.toFixed(3)}ms`);

    expect(median).toBeLessThan(1);
  });

  /**
   * Worst-case with all four field types: 250 rules x 4 types = 1000 rules.
   * Covers domain, paths, params, and pre-compiled pattern paths.
   */
  it('scans 1000 mixed-field PreparedRules in < 1ms (median over 51 runs)', () => {
    const prepared: PreparedRule[] = Array.from({ length: 250 }, (_, i) => {
      const domainLower = `net${i}.example.com`;
      return [
        {
          networkId: 'test',
          original: rule({ domain: domainLower }),
          sessionDuration: 86_400_000,
          domainLower,
          domainSuffix: '.' + domainLower,
        } satisfies PreparedRule,
        {
          networkId: 'test',
          original: rule({ paths: `/click/${i}` }),
          sessionDuration: 86_400_000,
          paths: [`/click/${i}`],
        } satisfies PreparedRule,
        {
          networkId: 'test',
          original: rule({ params: `afsrc${i}` }),
          sessionDuration: 86_400_000,
          params: [`afsrc${i}`],
        } satisfies PreparedRule,
        {
          networkId: 'test',
          original: rule({ pattern: `net${i}\\.example\\.com/click-\\d+` }),
          sessionDuration: 86_400_000,
          regexp: new RegExp(`net${i}\\.example\\.com/click-\\d+`, 'i'),
        } satisfies PreparedRule,
      ];
    }).flat();

    const probeUrl = 'https://no-match.io/page?unrelated=1';
    const parsedProbe = new URL(probeUrl);

    const median = medianMs(() => {
      for (const r of prepared) matchesPrepared(parsedProbe, probeUrl, r);
    });

    console.log(`[perf] 1000-rule mixed scan (matchesPrepared) median: ${median.toFixed(3)}ms`);

    expect(median).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Single-string normalisation for paths / params
// ---------------------------------------------------------------------------

describe('matchesRule: string vs array normalisation', () => {
  it('paths as string behaves the same as paths as single-element array', () => {
    const url = 'https://example.com/click/123';
    expect(matchesRule(url, rule({ paths: '/click' }))).toBe(
      matchesRule(url, rule({ paths: ['/click'] })),
    );
  });

  it('params as string behaves the same as params as single-element array', () => {
    const url = 'https://example.com/?afsrc=1';
    expect(matchesRule(url, rule({ params: 'afsrc' }))).toBe(
      matchesRule(url, rule({ params: ['afsrc'] })),
    );
  });
});
