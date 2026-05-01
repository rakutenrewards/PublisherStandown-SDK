/**
 * Standdown SDK Test Extension: Session Manager
 *
 * Maintains an in-memory map from root domain to affiliate session record.
 * Sessions are keyed by a simplified root domain derived from the final URL
 * in the redirect chain by stripping cosmetic hostname prefixes (www., m.).
 *
 * Sessions are capped at MAX_SESSIONS entries; the oldest entry is evicted
 * when the cap is reached and a new domain key is being inserted.
 *
 * This module is intentionally self-contained with no external dependencies.
 * It runs in the Manifest V3 service worker context and is exposed on
 * globalThis.__sessionManager for direct Playwright evaluation.
 */

interface SessionRecord {
  detectedAt: number;
  expiresAt: number | null;
  result: object;
  tabId: number;
}

/**
 * Derive the root domain key from a URL string.
 *
 * Strips the leading www. or m. subdomain prefix so that www.nike.com and
 * m.nike.com both map to nike.com. Subdomains other than www/m are preserved:
 * shop.nike.com stays shop.nike.com.
 *
 * Returns null for malformed URLs without throwing.
 */
function getRootDomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.replace(/^(?:www|m)\./, '');
  } catch {
    return null;
  }
}

export class SessionManager {
  static MAX_SESSIONS = 500;

  /**
   * In-memory session store: root domain → session record.
   * Map preserves insertion order, used for oldest-first eviction.
   */
  #sessions = new Map<string, SessionRecord>();

  /**
   * Record or refresh the session for the root domain of the given URL.
   *
   * When the map is at capacity and this is a new domain, the oldest entry
   * is evicted before inserting. A refresh (same domain, new detection) moves
   * the entry to the newest position so it is not evicted as stale.
   *
   * @param url    Final URL in the redirect chain (keyed to root domain).
   * @param result DetectionResult from checkForAffiliatePatterns.
   * @param tabId
   */
  record(url: string, result: { expiresAt?: number | null; [key: string]: unknown }, tabId: number): void {
    const domain = getRootDomain(url);
    if (domain === null) return;

    // Evict the oldest entry when at capacity and this is a genuinely new domain.
    if (!this.#sessions.has(domain) && this.#sessions.size >= SessionManager.MAX_SESSIONS) {
      // The map is non-empty here (size >= MAX_SESSIONS > 0), so .next().value is defined.
      const oldestKey = this.#sessions.keys().next().value!;
      this.#sessions.delete(oldestKey);
    }

    // Delete-then-set moves the entry to the newest insertion-order position.
    // This ensures a refreshed session is not mistakenly evicted as old.
    this.#sessions.delete(domain);
    this.#sessions.set(domain, { detectedAt: Date.now(), expiresAt: result.expiresAt ?? null, result, tabId });
  }

  /**
   * Return the session record for the root domain of the given URL, or null
   * if no session has been recorded for that domain or if the session has expired.
   *
   * Expired sessions are pruned lazily on access (no background timer, which is
   * unreliable in the Manifest V3 service-worker context).
   *
   * Returns null without throwing for malformed URLs.
   * The domain lookup is case-insensitive (handled by getRootDomain).
   */
  getSession(url: string): SessionRecord | null {
    const domain = getRootDomain(url);
    if (domain === null) return null;
    const session = this.#sessions.get(domain);
    if (session === undefined) return null;
    if (session.expiresAt !== null && session.expiresAt < Date.now()) {
      this.#sessions.delete(domain);
      return null;
    }
    return session;
  }

  /**
   * Return all non-expired sessions as a plain object { domain: sessionRecord, ... }.
   *
   * Expired sessions are pruned lazily during this call.
   *
   * Intended for Playwright direct evaluation and developer inspection.
   */
  getAllSessions(): Record<string, SessionRecord> {
    const now = Date.now();
    for (const [domain, session] of this.#sessions) {
      if (session.expiresAt !== null && session.expiresAt < now) {
        this.#sessions.delete(domain);
      }
    }
    return Object.fromEntries(this.#sessions);
  }

  /**
   * Remove all session records.
   *
   * Intended for testing only; allows Playwright tests to start from a known
   * empty state without relaunching the browser context.
   */
  clear(): void {
    this.#sessions.clear();
  }
}
