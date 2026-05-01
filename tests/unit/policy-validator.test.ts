/**
 * Unit tests for policy-validator: sessionDuration validation (EPIC1-005).
 *
 * Covers all branches of the sessionDuration guard in isValidPolicy():
 * absent (valid), valid positive, zero, negative, Infinity, NaN, non-number.
 */
import { describe, expect, it } from 'vitest';
import { isValidPolicy } from '../../src/validation/policy-validator.js';
import type { NetworkPolicy } from '../../src/types/index.js';

function makePolicy(
  overrides: Partial<NetworkPolicy> = {},
  networkOverrides: Partial<NetworkPolicy['network']> = {},
): NetworkPolicy {
  return {
    id: 'test-network',
    schemaVersion: 2,
    policyVersion: 1,
    network: { id: 'test', name: 'Test Network', ...overrides.network, ...networkOverrides },
    rules: [{ domain: 'example.com', reason: 'test rule' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EPIC1-005: isValidPolicy -- sessionDuration validation
// ---------------------------------------------------------------------------

describe('isValidPolicy: sessionDuration validation', () => {
  it('accepts a policy without sessionDuration (field is optional)', () => {
    expect(isValidPolicy(makePolicy())).toBe(true);
  });

  it('accepts a policy with a valid positive sessionDuration', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:86_400_000 }))).toBe(true);
  });

  it('accepts sessionDuration of 1 (smallest valid positive value)', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:1 }))).toBe(true);
  });

  it('accepts a non-integer positive sessionDuration', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:1.5 }))).toBe(true);
  });

  it('rejects sessionDuration of 0', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:0 }))).toBe(false);
  });

  it('rejects a negative sessionDuration', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:-3_600_000 }))).toBe(false);
  });

  it('rejects Infinity as sessionDuration', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:Infinity }))).toBe(false);
  });

  it('rejects -Infinity as sessionDuration', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:-Infinity }))).toBe(false);
  });

  it('rejects NaN as sessionDuration', () => {
    expect(isValidPolicy(makePolicy({}, { sessionDuration:NaN }))).toBe(false);
  });

  it('rejects a string sessionDuration (malformed JSON-parsed policy)', () => {
    expect(
      isValidPolicy(makePolicy({}, { sessionDuration:'86400000' as unknown as number })),
    ).toBe(false);
  });
});
