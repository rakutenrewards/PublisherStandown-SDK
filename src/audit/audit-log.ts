/**
 * AuditLog: opt-in affiliate event persistence for the Standdown SDK.
 *
 * Maintains an in-memory Map<rootDomain, AffiliateEvent> that is persisted to
 * chrome.storage.local under a single namespaced key. Reads always come from
 * the in-memory cache; storage is written on every update (fire-and-forget).
 *
 * Lifecycle:
 *   1. Construct with optional injectable StorageDeps (for testing).
 *   2. Call loadFromStorage() once (e.g. inside StanddownSDK.create()) to
 *      hydrate the cache from any previously persisted entries.
 *   3. Call record() whenever a positive detection occurs.
 *   4. Call getAll() to retrieve all active (non-expired) entries.
 *
 * Expiry is lazy: entries are pruned when read, not on a background timer.
 * No alarms permission is required.
 */

import type { AffiliateEvent } from '../types/index.js';
import { extractRootDomain } from './domain.js';
import { buildStorageDeps } from './storage-deps.js';
import type { StorageDeps } from './storage-deps.js';

const STORAGE_KEY = 'standdown:audit-log';

export class AuditLog {
  private readonly cache: Map<string, AffiliateEvent> = new Map();
  private readonly deps: StorageDeps;

  /**
   * @param deps  Injectable StorageDeps. When omitted, uses buildStorageDeps()
   *              which wraps chrome.storage.local (only valid in extension contexts).
   */
  constructor(deps?: StorageDeps) {
    this.deps = deps ?? buildStorageDeps();
  }

  /**
   * Hydrate the in-memory cache from chrome.storage.local.
   * Call once during SDK initialization (StanddownSDK.create()).
   * Silently no-ops on read errors or missing/malformed data.
   */
  async loadFromStorage(): Promise<void> {
    try {
      const result = await this.deps.get(STORAGE_KEY);
      const stored = result[STORAGE_KEY];
      if (stored == null || typeof stored !== 'object' || Array.isArray(stored)) return;
      for (const [domain, entry] of Object.entries(stored as Record<string, unknown>)) {
        if (isAffiliateEvent(entry)) {
          // Normalize legacy entries written before isOwnAffiliateLink was added.
          // The guard does not check this field so legacy entries pass without it.
          this.cache.set(domain, {
            ...entry,
            isOwnAffiliateLink: entry.isOwnAffiliateLink ?? false,
          });
        }
      }
    } catch (err) {
      console.warn('[standdown-sdk] AuditLog: failed to load from storage', err);
    }
  }

  /**
   * Record an affiliate detection event.
   *
   * The entry is keyed by the root domain extracted from event.url. A new
   * detection on the same root domain overwrites the existing entry.
   * No-op when the URL cannot be parsed to a root domain.
   *
   * The cache is updated synchronously; the storage write is async and
   * fire-and-forget (does not block the caller).
   */
  record(event: AffiliateEvent): void {
    const domain = extractRootDomain(event.url);
    if (domain === null) return;
    this.cache.set(domain, event);
    void this.persistToStorage();
  }

  /**
   * Return all non-expired entries from the in-memory cache.
   *
   * Entries where timestamp + sessionDuration < Date.now() are pruned lazily.
   * If any entries were pruned, the updated cache is persisted to storage.
   */
  getAll(): AffiliateEvent[] {
    const now = Date.now();
    let pruned = false;
    for (const [domain, event] of this.cache) {
      if (event.timestamp + event.sessionDuration < now) {
        this.cache.delete(domain);
        pruned = true;
      }
    }
    if (pruned) void this.persistToStorage();
    return [...this.cache.values()];
  }

  /**
   * Return all non-expired entries matching the given URL or bare domain.
   *
   * Accepts a full URL (e.g. `https://www.gap.com/jeans`) or a bare domain
   * (e.g. `gap.com`, `shop.gap.com`). Both are normalized to root domain via
   * `extractRootDomain`. Returns `[]` for unknown, expired, or unparseable input.
   */
  getByDomain(input: string): AffiliateEvent[] {
    const domain = extractRootDomain(input);
    if (domain === null) return [];
    const entry = this.cache.get(domain);
    if (entry === undefined) return [];
    if (entry.timestamp + entry.sessionDuration < Date.now()) {
      this.cache.delete(domain);
      void this.persistToStorage();
      return [];
    }
    return [entry];
  }

  /**
   * Persist the current in-memory cache to storage.
   * Errors are caught and logged; they do not propagate to callers.
   */
  private async persistToStorage(): Promise<void> {
    try {
      await this.deps.set(STORAGE_KEY, Object.fromEntries(this.cache));
    } catch (err) {
      console.warn('[standdown-sdk] AuditLog: failed to persist to storage', err);
    }
  }
}

/**
 * Runtime type guard: verify a deserialized value has the AffiliateEvent shape.
 * Used when reading back stored entries that may have been written by an older
 * SDK version or may be structurally invalid.
 *
 * Returns a widened type that treats isOwnAffiliateLink as optional, since entries
 * written by older SDK versions will not have this field. Callers must normalize
 * the field (e.g. `?? false`) after the guard passes.
 */
function isAffiliateEvent(value: unknown): value is Omit<AffiliateEvent, 'isOwnAffiliateLink'> & { isOwnAffiliateLink?: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['url'] === 'string' &&
    typeof v['timestamp'] === 'number' &&
    typeof v['sessionDuration'] === 'number' &&
    Array.isArray(v['matchedPatterns']) &&
    Array.isArray(v['redirectChain'])
  );
}
