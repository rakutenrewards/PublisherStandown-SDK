/**
 * Standdown SDK shared constants.
 *
 * A dedicated constants module avoids circular imports between the types,
 * validation, and detection layers, all of which need this value.
 */

/** Default stand-down session duration when a policy does not specify one: 30 minutes in milliseconds. */
export const DEFAULT_SESSION_DURATION_MS = 1_800_000;
