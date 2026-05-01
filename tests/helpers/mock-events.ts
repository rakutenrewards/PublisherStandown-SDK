import { vi } from 'vitest';

/**
 * Generic mock event emitter: addListener registers callbacks, fire() invokes them.
 *
 * Use for NavigationTracker unit tests and integration test event simulation
 * where you need to drive events but do not need to assert on addListener calls.
 */
export function makeMockEvent<T>(): {
  addListener(cb: (details: T) => void): void;
  removeListener(cb: (details: T) => void): void;
  fire(details: T): void;
} {
  let listeners: Array<(details: T) => void> = [];
  return {
    addListener(cb: (details: T) => void): void {
      listeners.push(cb);
    },
    removeListener(cb: (details: T) => void): void {
      listeners = listeners.filter((l) => l !== cb);
    },
    fire(details: T): void {
      listeners.forEach((cb) => cb(details));
    },
  };
}

/**
 * Spy-wrapped mock event emitter: addListener and removeListener are vi.fn() spies.
 *
 * Use when a test needs to assert how many times addListener/removeListener was called
 * (e.g., verifying TrackerDeps wiring in the Firefox namespace resolution tests).
 * The spies still register/deregister callbacks so fire() works if needed.
 */
export function makeSpyEvent<T>(): {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  fire(details: T): void;
} {
  let listeners: Array<(details: T) => void> = [];
  const addListener = vi.fn((cb: (details: T) => void) => {
    listeners.push(cb);
  });
  const removeListener = vi.fn((cb: (details: T) => void) => {
    listeners = listeners.filter((l) => l !== cb);
  });
  return {
    addListener,
    removeListener,
    fire: (details: T) => listeners.forEach((cb) => cb(details)),
  };
}
