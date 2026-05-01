/**
 * SessionManager unit tests: EPIC2-001 / EPIC2-002
 *
 * Tests expiry-aware behaviour: record() stores expiresAt, getSession() and
 * getAllSessions() prune expired entries lazily without a background timer.
 *
 * Date.now() is controlled via vi.spyOn so tests are deterministic and do not
 * rely on real clock progression.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../sample-extensions/session-manager/session-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MERCHANT_URL = 'https://www.nike.com/checkout';
const MERCHANT_DOMAIN = 'nike.com';

const PARTNER_URL = 'https://adidas.com/products';
const PARTNER_DOMAIN = 'adidas.com';

function makeResult(expiresAt: number | null) {
  return {
    hasAffiliatePattern: true,
    matchedPatterns: [{ network: 'cj', rule: { domain: 'dpbolvw.net', reason: 'test' }, url: 'https://dpbolvw.net/click' }],
    redirectChain: ['https://dpbolvw.net/click', MERCHANT_URL],
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// EPIC2-002: record() -- stores expiresAt from result
// ---------------------------------------------------------------------------

describe('SessionManager.record(): expiresAt storage', () => {
  it('stores expiresAt from the result when present', () => {
    const sm = new SessionManager();
    const expiresAt = Date.now() + 86_400_000;
    sm.record(MERCHANT_URL, makeResult(expiresAt), 1);
    const session = sm.getSession(MERCHANT_URL);
    expect(session).not.toBeNull();
    expect(session!.expiresAt).toBe(expiresAt);
  });

  it('stores expiresAt as null when result.expiresAt is null', () => {
    const sm = new SessionManager();
    sm.record(MERCHANT_URL, makeResult(null), 1);
    const session = sm.getSession(MERCHANT_URL);
    expect(session).not.toBeNull();
    expect(session!.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EPIC2-002: getSession() -- lazy expiry pruning
// ---------------------------------------------------------------------------

describe('SessionManager.getSession(): expiry pruning', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('returns the session when expiresAt is in the future', () => {
    const sm = new SessionManager();
    const recorded = 1_000_000_000_000;
    nowSpy.mockReturnValue(recorded);
    sm.record(MERCHANT_URL, makeResult(recorded + 3_600_000), 1);

    nowSpy.mockReturnValue(recorded + 1_800_000); // 30 min later, still valid
    const session = sm.getSession(MERCHANT_URL);
    expect(session).not.toBeNull();
  });

  it('returns null and prunes the entry when expiresAt is in the past', () => {
    const sm = new SessionManager();
    const recorded = 1_000_000_000_000;
    nowSpy.mockReturnValue(recorded);
    sm.record(MERCHANT_URL, makeResult(recorded + 1_000), 1);

    nowSpy.mockReturnValue(recorded + 2_000); // after expiry
    expect(sm.getSession(MERCHANT_URL)).toBeNull();
    // Entry must be removed; calling again with clock still past expiry returns null
    expect(sm.getSession(MERCHANT_URL)).toBeNull();
  });

  it('is not expired exactly at the expiresAt timestamp (strict < boundary)', () => {
    // Expiry condition is expiresAt < Date.now(): strict less-than.
    // A session whose expiresAt === now has not yet crossed the boundary.
    const sm = new SessionManager();
    const expiresAt = 1_000_000_000_000;
    nowSpy.mockReturnValue(expiresAt - 1);
    sm.record(MERCHANT_URL, makeResult(expiresAt), 1);

    nowSpy.mockReturnValue(expiresAt);
    expect(sm.getSession(MERCHANT_URL)).not.toBeNull();
  });

  it('is expired 1ms past expiresAt', () => {
    const sm = new SessionManager();
    const expiresAt = 1_000_000_000_000;
    nowSpy.mockReturnValue(expiresAt - 1);
    sm.record(MERCHANT_URL, makeResult(expiresAt), 1);

    nowSpy.mockReturnValue(expiresAt + 1);
    expect(sm.getSession(MERCHANT_URL)).toBeNull();
  });

  it('never expires a session whose expiresAt is null', () => {
    const sm = new SessionManager();
    const recorded = 1_000_000_000_000;
    nowSpy.mockReturnValue(recorded);
    sm.record(MERCHANT_URL, makeResult(null), 1);

    // Advance far into the future
    nowSpy.mockReturnValue(recorded + 999_999_999_999);
    expect(sm.getSession(MERCHANT_URL)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EPIC2-002: getAllSessions() -- lazy expiry pruning of all entries
// ---------------------------------------------------------------------------

describe('SessionManager.getAllSessions(): expiry pruning', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('omits expired sessions and retains valid ones', () => {
    const sm = new SessionManager();
    const now = 1_000_000_000_000;
    nowSpy.mockReturnValue(now);

    sm.record(MERCHANT_URL, makeResult(now + 3_600_000), 1);  // expires in 1h
    sm.record(PARTNER_URL, makeResult(now + 500), 2);          // expires in 500ms

    nowSpy.mockReturnValue(now + 1_000); // 1s later: PARTNER expired
    const result = sm.getAllSessions();

    expect(Object.keys(result)).toHaveLength(1);
    expect(result[MERCHANT_DOMAIN]).toBeDefined();
    expect(result[PARTNER_DOMAIN]).toBeUndefined();
  });

  it('returns an empty object when all sessions have expired', () => {
    const sm = new SessionManager();
    const now = 1_000_000_000_000;
    nowSpy.mockReturnValue(now);

    sm.record(MERCHANT_URL, makeResult(now + 100), 1);
    nowSpy.mockReturnValue(now + 200);

    expect(sm.getAllSessions()).toEqual({});
  });

  it('returns all sessions when none have expired', () => {
    const sm = new SessionManager();
    const now = 1_000_000_000_000;
    nowSpy.mockReturnValue(now);

    sm.record(MERCHANT_URL, makeResult(now + 86_400_000), 1);
    sm.record(PARTNER_URL, makeResult(now + 86_400_000), 2);

    const result = sm.getAllSessions();
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('includes sessions whose expiresAt is null regardless of time', () => {
    const sm = new SessionManager();
    const now = 1_000_000_000_000;
    nowSpy.mockReturnValue(now);
    sm.record(MERCHANT_URL, makeResult(null), 1);

    nowSpy.mockReturnValue(now + 999_999_999_999);
    const result = sm.getAllSessions();
    expect(result[MERCHANT_DOMAIN]).toBeDefined();
  });
});
