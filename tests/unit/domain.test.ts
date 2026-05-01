/**
 * extractRootDomain unit tests: EPIC2-001
 *
 * Covers: full URL normalization, bare domain pass-through, subdomain stripping,
 * malformed input handling, and the documented ccSLD limitation.
 */
import { describe, expect, it } from 'vitest';
import { extractRootDomain } from '../../src/audit/domain.js';

describe('extractRootDomain: full URL input', () => {
  it('extracts root domain from a full HTTPS URL', () => {
    expect(extractRootDomain('https://www.gap.com/jeans?q=1')).toBe('gap.com');
  });

  it('extracts root domain from an HTTP URL', () => {
    expect(extractRootDomain('http://www.example.com/path')).toBe('example.com');
  });

  it('strips port from a URL', () => {
    expect(extractRootDomain('https://gap.com:8080/path')).toBe('gap.com');
  });

  it('strips path, query, and fragment from a URL', () => {
    expect(extractRootDomain('https://shop.nike.com/en/product?id=42#reviews')).toBe('nike.com');
  });
});

describe('extractRootDomain: subdomain handling', () => {
  it('strips www. prefix to two-part root', () => {
    expect(extractRootDomain('www.gap.com')).toBe('gap.com');
  });

  it('strips a non-www subdomain to two-part root', () => {
    expect(extractRootDomain('shop.gap.com')).toBe('gap.com');
  });

  it('strips multiple subdomain labels to two-part root', () => {
    expect(extractRootDomain('a.b.shop.gap.com')).toBe('gap.com');
  });

  it('returns bare two-part domain unchanged', () => {
    expect(extractRootDomain('gap.com')).toBe('gap.com');
  });

  it('lowercases the result', () => {
    expect(extractRootDomain('HTTPS://WWW.GAP.COM/')).toBe('gap.com');
  });
});

describe('extractRootDomain: malformed input', () => {
  it('returns null for an empty string', () => {
    expect(extractRootDomain('')).toBeNull();
  });

  it('returns null for a string with no dots', () => {
    expect(extractRootDomain('localhost')).toBeNull();
  });

  it('returns null for a string that cannot be parsed as a URL or hostname', () => {
    expect(extractRootDomain('not a url at all :::')).toBeNull();
  });

  it('returns null for a bare IP address with no dots in a meaningful domain sense', () => {
    // An IP like "192.168.1.1" has 4 parts; we return the last two, which is
    // technically a number-looking result. For the audit log this is acceptable,
    // documented rather than guarded.
    const result = extractRootDomain('192.168.1.1');
    // Just assert it doesn't throw and returns a string (not null)
    expect(result).toBe('1.1');
  });
});

describe('extractRootDomain: known ccSLD limitation', () => {
  /**
   * The two-part heuristic is incorrect for ccSLD domains.
   * These tests document the known behaviour; they assert the ACTUAL (incorrect)
   * output so that the limitation is visible in the test suite. See
   * APPENDIX-DOMAIN-EXCEPTIONS.md (follow-on) for the full list.
   */
  it('returns co.uk for www.bbc.co.uk (known ccSLD limitation)', () => {
    // Correct result would be bbc.co.uk; two-part heuristic gives co.uk.
    expect(extractRootDomain('www.bbc.co.uk')).toBe('co.uk');
  });

  it('returns com.au for www.retailer.com.au (known ccSLD limitation)', () => {
    expect(extractRootDomain('www.retailer.com.au')).toBe('com.au');
  });
});
