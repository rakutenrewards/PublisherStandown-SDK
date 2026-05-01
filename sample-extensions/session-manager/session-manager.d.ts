/**
 * Type declarations for test-extension/session-manager.js
 * Kept separate so TypeScript tests can import SessionManager with full type safety.
 */

export interface SessionRecord {
  detectedAt: number;
  expiresAt: number | null;
  result: object;
  tabId: number;
}

export declare class SessionManager {
  static MAX_SESSIONS: number;

  record(url: string, result: { expiresAt?: number | null; [key: string]: unknown }, tabId: number): void;
  getSession(url: string): SessionRecord | null;
  getAllSessions(): Record<string, SessionRecord>;
  clear(): void;
}
