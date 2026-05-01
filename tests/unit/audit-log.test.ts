/**
 * AuditLog unit tests: EPIC1-008
 *
 * Covers: record(), getAll(), loadFromStorage(), lazy expiry, persistence
 * error handling, and the isAffiliateEvent runtime guard.
 *
 * StorageDeps is injected via the constructor; no real chrome APIs are used.
 * Date.now() is controlled via vi.spyOn for deterministic expiry tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import type { StorageDeps } from '../../src/audit/storage-deps.js';
import type { AffiliateEvent } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'standdown:audit-log';

function makeDeps(initial?: Record<string, unknown>) {
  const store = new Map<string, unknown>(
    initial ? Object.entries(initial) : [],
  );
  // Expose mock functions as named refs to avoid @typescript-eslint/unbound-method
  // errors when passing them to expect().
  const mockGet = vi.fn((key: string) => Promise.resolve({ [key]: store.get(key) ?? null }));
  const mockSet = vi.fn((key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); });
  const deps: StorageDeps = { get: mockGet, set: mockSet };
  return { deps, mockGet, mockSet, store };
}

function makeEvent(url: string, overrides: Partial<AffiliateEvent> = {}): AffiliateEvent {
  return {
    url,
    timestamp: Date.now(),
    sessionDuration: 86_400_000, // 24 h
    matchedPatterns: [],
    redirectChain: [url],
    isOwnAffiliateLink: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// record() -- cache update and storage persistence
// ---------------------------------------------------------------------------

describe('AuditLog.record(): cache update', () => {
  it('stores an entry keyed by root domain', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const event = makeEvent('https://www.gap.com/jeans');
    log.record(event);
    expect(log.getAll()).toHaveLength(1);
    expect(log.getAll()[0]).toEqual(event);
  });

  it('uses the root domain as the key (subdomain stripped)', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://shop.nike.com/'));
    // Keyed as nike.com; getAll returns the entry
    expect(log.getAll()).toHaveLength(1);
  });

  it('overwrites an existing entry for the same root domain', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const base = 1_000_000_000_000;
      nowSpy.mockReturnValue(base);
      const { deps } = makeDeps();
      const log = new AuditLog(deps);
      const first = makeEvent('https://www.gap.com/', { timestamp: base, sessionDuration: 86_400_000 });
      nowSpy.mockReturnValue(base + 1_000);
      const second = makeEvent('https://gap.com/', { timestamp: base + 1_000, sessionDuration: 86_400_000 });
      log.record(first);
      log.record(second);
      const all = log.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.timestamp).toBe(base + 1_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('stores entries for different root domains independently', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://gap.com/'));
    log.record(makeEvent('https://nike.com/'));
    expect(log.getAll()).toHaveLength(2);
  });

  it('calls deps.set with the storage key after record()', () => {
    const { deps, mockSet } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://gap.com/'));
    expect(mockSet).toHaveBeenCalledWith(STORAGE_KEY, expect.objectContaining({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      'gap.com': expect.objectContaining({ url: 'https://gap.com/' }),
    }));
  });

  it('is a no-op for a malformed URL that cannot yield a root domain', () => {
    const { deps, mockSet } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('not a url at all :::'));
    expect(log.getAll()).toHaveLength(0);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAll() -- lazy expiry pruning
// ---------------------------------------------------------------------------

describe('AuditLog.getAll(): lazy expiry', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('returns an active entry whose session has not elapsed', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const base = 1_000_000_000_000;
    nowSpy.mockReturnValue(base);
    log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 3_600_000 }));

    nowSpy.mockReturnValue(base + 1_800_000); // 30 min later, still active
    expect(log.getAll()).toHaveLength(1);
  });

  it('prunes and does not return an expired entry', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const base = 1_000_000_000_000;
    nowSpy.mockReturnValue(base);
    log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 1_000 }));

    nowSpy.mockReturnValue(base + 2_000); // past expiry
    expect(log.getAll()).toHaveLength(0);
  });

  it('prunes only expired entries, leaving active ones intact', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const base = 1_000_000_000_000;
    nowSpy.mockReturnValue(base);
    log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 500 }));      // expires in 500ms
    log.record(makeEvent('https://nike.com/', { timestamp: base, sessionDuration: 3_600_000 })); // 1h, active

    nowSpy.mockReturnValue(base + 1_000); // gap.com expired; nike.com active
    const result = log.getAll();
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://nike.com/');
  });

  it('calls deps.set after pruning expired entries', () => {
    const { deps, mockSet } = makeDeps();
    const log = new AuditLog(deps);
    const base = 1_000_000_000_000;
    nowSpy.mockReturnValue(base);
    log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 500 }));
    mockSet.mockClear(); // reset the set call from record()

    nowSpy.mockReturnValue(base + 1_000);
    log.getAll();
    expect(mockSet).toHaveBeenCalledOnce();
  });

  it('does not call deps.set when no entries were pruned', () => {
    const { deps, mockSet } = makeDeps();
    const log = new AuditLog(deps);
    const base = 1_000_000_000_000;
    nowSpy.mockReturnValue(base);
    log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 86_400_000 }));
    mockSet.mockClear();

    nowSpy.mockReturnValue(base + 1_000); // well before expiry
    log.getAll();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('returns an empty array when the cache is empty', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    expect(log.getAll()).toEqual([]);
  });

  it('entry expiring at exactly now is still active (strict < boundary)', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const base = 1_000_000_000_000;
    nowSpy.mockReturnValue(base);
    log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 1_000 }));

    // timestamp + sessionDuration === base + 1_000; now === base + 1_000
    // Condition: (base + 1_000) < (base + 1_000) → false → not expired
    nowSpy.mockReturnValue(base + 1_000);
    expect(log.getAll()).toHaveLength(1);

    // 1ms past expiry → expired
    nowSpy.mockReturnValue(base + 1_001);
    expect(log.getAll()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadFromStorage() -- hydration
// ---------------------------------------------------------------------------

describe('AuditLog.loadFromStorage(): hydration', () => {
  it('populates the cache from stored entries', async () => {
    const base = 1_000_000_000_000;
    const storedEvent: AffiliateEvent = {
      url: 'https://gap.com/',
      timestamp: base,
      sessionDuration: 86_400_000,
      matchedPatterns: [],
      redirectChain: ['https://gap.com/'],
      isOwnAffiliateLink: false,
    };
    const { deps } = makeDeps({
      [STORAGE_KEY]: { 'gap.com': storedEvent },
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base + 1_000); // well before expiry
    try {
      const log = new AuditLog(deps);
      await log.loadFromStorage();
      const all = log.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(storedEvent);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('handles a missing key gracefully (returns empty cache)', async () => {
    const { deps } = makeDeps(); // no pre-stored data
    const log = new AuditLog(deps);
    await log.loadFromStorage();
    expect(log.getAll()).toEqual([]);
  });

  it('handles a null stored value gracefully', async () => {
    const { deps } = makeDeps({ [STORAGE_KEY]: null });
    const log = new AuditLog(deps);
    await log.loadFromStorage();
    expect(log.getAll()).toEqual([]);
  });

  it('skips entries that do not match the AffiliateEvent shape', async () => {
    const base = 1_000_000_000_000;
    const valid: AffiliateEvent = {
      url: 'https://gap.com/',
      timestamp: base,
      sessionDuration: 86_400_000,
      matchedPatterns: [],
      redirectChain: ['https://gap.com/'],
      isOwnAffiliateLink: false,
    };
    const invalid = { foo: 'bar' }; // missing required fields
    const { deps } = makeDeps({
      [STORAGE_KEY]: { 'gap.com': valid, 'nike.com': invalid },
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base + 1_000);
    try {
      const log = new AuditLog(deps);
      await log.loadFromStorage();
      expect(log.getAll()).toHaveLength(1);
      expect(log.getAll()[0]?.url).toBe('https://gap.com/');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('emits a console.warn and leaves cache empty when deps.get throws', async () => {
    const deps: StorageDeps = {
      get: vi.fn(() => Promise.reject(new Error('storage unavailable'))),
      set: vi.fn(() => Promise.resolve()),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = new AuditLog(deps);
    await log.loadFromStorage();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[standdown-sdk] AuditLog'),
      expect.any(Error),
    );
    expect(log.getAll()).toEqual([]);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// persistToStorage() error handling (via record())
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getByDomain() -- EPIC2-004
// ---------------------------------------------------------------------------

describe('AuditLog.getByDomain()', () => {
  it('returns the matching entry for a full URL input', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const event = makeEvent('https://www.gap.com/jeans');
    log.record(event);
    const result = log.getByDomain('https://www.gap.com/jeans');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(event);
  });

  it('returns the matching entry for a bare root domain input', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://gap.com/'));
    const result = log.getByDomain('gap.com');
    expect(result).toHaveLength(1);
  });

  it('returns the matching entry when a subdomain input normalizes to the stored root domain', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://gap.com/'));
    // shop.gap.com → gap.com; should match the stored entry
    const result = log.getByDomain('shop.gap.com');
    expect(result).toHaveLength(1);
  });

  it('returns [] for an unknown domain', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://gap.com/'));
    expect(log.getByDomain('nike.com')).toEqual([]);
  });

  it('returns [] and prunes the entry when the session has expired', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const base = 1_000_000_000_000;
      nowSpy.mockReturnValue(base);
      const { deps, mockSet } = makeDeps();
      const log = new AuditLog(deps);
      log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 500 }));
      mockSet.mockClear();

      nowSpy.mockReturnValue(base + 1_000); // past expiry
      const result = log.getByDomain('gap.com');
      expect(result).toEqual([]);
      // The pruned cache should have been persisted
      expect(mockSet).toHaveBeenCalledOnce();
      // Subsequent getAll() confirms the entry was removed
      expect(log.getAll()).toHaveLength(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns [] for a malformed input', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://gap.com/'));
    expect(log.getByDomain('not a url :::')).toEqual([]);
  });

  it('returns a non-expired entry that is still active', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const base = 1_000_000_000_000;
      nowSpy.mockReturnValue(base);
      const { deps } = makeDeps();
      const log = new AuditLog(deps);
      log.record(makeEvent('https://gap.com/', { timestamp: base, sessionDuration: 3_600_000 }));

      nowSpy.mockReturnValue(base + 1_800_000); // 30 min later, still active
      const result = log.getByDomain('gap.com');
      expect(result).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// AuditLog: isOwnAffiliateLink field
// ---------------------------------------------------------------------------

describe('AuditLog: isOwnAffiliateLink field', () => {
  it('persists isOwnAffiliateLink: true when event is recorded with true', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    const event = makeEvent('https://www.gap.com/', { isOwnAffiliateLink: true });
    log.record(event);
    expect(log.getAll()[0]?.isOwnAffiliateLink).toBe(true);
  });

  it('persists isOwnAffiliateLink: false when event is recorded with false', () => {
    const { deps } = makeDeps();
    const log = new AuditLog(deps);
    log.record(makeEvent('https://www.gap.com/')); // default is false
    expect(log.getAll()[0]?.isOwnAffiliateLink).toBe(false);
  });

  it('defaults isOwnAffiliateLink to false when loading a legacy entry without the field', async () => {
    // Simulate an entry written by an older SDK version (no isOwnAffiliateLink field)
    const legacyEntry = {
      url: 'https://gap.com/',
      timestamp: Date.now(),
      sessionDuration: 86_400_000,
      matchedPatterns: [],
      redirectChain: ['https://gap.com/'],
      // isOwnAffiliateLink intentionally absent
    };
    const { deps } = makeDeps({ [STORAGE_KEY]: { 'gap.com': legacyEntry } });
    const log = new AuditLog(deps);
    await log.loadFromStorage();
    expect(log.getAll()[0]?.isOwnAffiliateLink).toBe(false);
  });

  it('preserves isOwnAffiliateLink: true when loading a stored entry that has the field', async () => {
    const entry = {
      url: 'https://gap.com/',
      timestamp: Date.now(),
      sessionDuration: 86_400_000,
      matchedPatterns: [],
      redirectChain: ['https://gap.com/'],
      isOwnAffiliateLink: true,
    };
    const { deps } = makeDeps({ [STORAGE_KEY]: { 'gap.com': entry } });
    const log = new AuditLog(deps);
    await log.loadFromStorage();
    expect(log.getAll()[0]?.isOwnAffiliateLink).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('AuditLog: storage write failure', () => {
  it('emits a console.warn and does not throw when deps.set rejects', async () => {
    const deps: StorageDeps = {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.reject(new Error('quota exceeded'))),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = new AuditLog(deps);
    // record() calls void persistToStorage(); must not throw
    expect(() => log.record(makeEvent('https://gap.com/'))).not.toThrow();
    // Wait for the async persistToStorage to settle
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[standdown-sdk] AuditLog'),
      expect.any(Error),
    );
    // In-memory cache is unaffected
    expect(log.getAll()).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
