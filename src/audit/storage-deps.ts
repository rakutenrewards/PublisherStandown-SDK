/**
 * Injectable abstraction over chrome.storage.local.
 *
 * AuditLog accepts a StorageDeps instance at construction time so that unit
 * tests can supply a mock without a real browser runtime. In production,
 * AuditLog calls buildStorageDeps() internally when no deps are provided.
 *
 * This mirrors the TrackerDeps pattern used by NavigationTracker.
 */

export interface StorageDeps {
  /** Read the value stored at key. Returns { [key]: value } or { [key]: undefined } if absent. */
  get(key: string): Promise<Record<string, unknown>>;
  /** Write value at key. */
  set(key: string, value: unknown): Promise<void>;
}

/**
 * Builds a StorageDeps implementation backed by chrome.storage.local.
 * Only call this in a browser extension context where chrome.storage is available.
 */
export function buildStorageDeps(): StorageDeps {
  return {
    async get(key: string): Promise<Record<string, unknown>> {
      const result = await chrome.storage.local.get(key);
      return result as Record<string, unknown>;
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}
