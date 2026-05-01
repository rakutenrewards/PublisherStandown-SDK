# @rakuten-rewards/standdown-sdk

[![CI](https://github.com/rewards-lifecycle/standdown-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/rewards-lifecycle/standdown-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Zero-dependency TypeScript SDK for detecting affiliate redirect patterns in Manifest V3 browser extensions. When your extension's background service worker needs to decide whether to **stand down** (skip affiliate link injection because another affiliate network already owns the session), call `checkForAffiliatePatterns(tabId)` and act on the result.

- Detects affiliate redirect chains against integrator-supplied affiliate network policies
- Dual ESM + CJS bundle with TypeScript declarations: ~6 KB gzipped, ~21 KB estimated code size
- Zero runtime dependencies, fully typed (no `any`)

---

## Table of Contents

- [Installation](#installation)
- [Browser Compatibility](#browser-compatibility)
- [Manifest V3 Permissions](#manifest-v3-permissions)
- [Quick Start](#quick-start)
- [Supplying Policies](#supplying-policies)
- [Inspecting Results](#inspecting-results)
- [Handling Your Own Affiliate Links](#handling-your-own-affiliate-links)
- [Audit Log](#audit-log)
- [TypeScript API Reference](#typescript-api-reference)
- [Graceful Degradation](#graceful-degradation)
- [Security Considerations](#security-considerations)
- [License](#license)

---

## Installation

```bash
npm install @rakuten-rewards/standdown-sdk
# or
pnpm add @rakuten-rewards/standdown-sdk
```

---

## Browser Compatibility

| Browser | Supported | Notes |
|---------|-----------|-------|
| Chrome | ✅ | Primary target |
| Microsoft Edge | ✅ | Chromium-based; uses the same `chrome.*` APIs as Chrome with no additional configuration required |
| Firefox | ✅ | The SDK automatically resolves the `browser` namespace (Firefox) and `chrome` namespace (Chrome / Edge) at runtime |
| Safari | ✅ | Requires Safari 16.4+ (macOS Ventura 13.3) for MV3 service worker support. The SDK uses URL-mismatch detection in place of `transitionQualifiers`, which Safari does not populate. Validated via unit tests; automated E2E is not available (Playwright does not support Safari extension loading). |

---

## Manifest V3 Permissions

Add these permissions to your `manifest.json`:

```json
{
  "permissions": ["webNavigation", "webRequest", "tabs"],
  "host_permissions": ["<all_urls>"]
}
```

`webNavigation` is required to observe redirect chains and committed navigations. `webRequest` (with `host_permissions: ["<all_urls>"]`) is required to observe intermediate redirect hops via `onBeforeRequest`. `tabs` is required for tab lifecycle cleanup (clearing state when a tab closes).

If you enable the optional [Audit Log](#audit-log), add `"storage"` to persist detections across service worker restarts:

```json
{
  "permissions": ["webNavigation", "webRequest", "tabs", "storage"],
  "host_permissions": ["<all_urls>"]
}
```

---

## Quick Start

Define your affiliate network policies and pass them at construction. Call `checkForAffiliatePatterns(tabId)` from any existing navigation handler whenever you need to make a stand-down decision for a specific tab:

```ts
import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';
import type { NetworkPolicy } from '@rakuten-rewards/standdown-sdk';

const MY_POLICIES: NetworkPolicy[] = [
  {
    id: 'cj',
    schemaVersion: 2,
    policyVersion: 1,
    network: { id: 'cj', name: 'Commission Junction', sessionDuration: 1_800_000 },
    rules: [
      { domain: 'dpbolvw.net', reason: 'CJ primary click-tracking domain' },
      { domain: 'anrdoezrs.net', reason: 'CJ click-tracking domain variant' },
      { params: 'cjevent', reason: 'CJ event tracking parameter' },
    ],
  },
  // Add a policy object for each affiliate network you want to detect.
];

// Instantiate once in your background service worker.
// The SDK registers browser event listeners automatically.
// If you ever need to re-create the instance, call shield.destroy() first
// to remove the old listeners and prevent ghost callbacks.
const shield = new StanddownSDK({ policies: MY_POLICIES });

// In your message handler or action listener:
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_STANDDOWN' && sender.tab?.id != null) {
    const result = shield.checkForAffiliatePatterns(sender.tab.id);

    if (result.hasAffiliatePattern) {
      // Another affiliate network owns this session; stand down.
      sendResponse({ standDown: true });
    } else {
      sendResponse({ standDown: false });
    }
  }
});
```

> **How it works:** `checkForAffiliatePatterns` inspects the redirect chain observed for a _specific tab_. This covers the classical affiliate activation model: a user clicks an affiliate link, passes through the network's redirect hop, and arrives at a merchant page with the session already attributed. Call it from your `webNavigation.onCompleted` (or `onErrorOccurred`) listener so it runs as soon as navigation settles; the full chain is available at that point.

> **Complete working example:** `sample-extensions/session-manager/service-worker.js` in this repository is a production-oriented service worker demonstrating SDK initialization with policies, navigation listeners, session management, and stand-down decision logic. When in doubt, treat it as the canonical reference.

> **Integration patterns:** [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) covers session management (including background-tab activation), own affiliate link detection, the audit log, and policy configuration. See it for everything beyond the basic stand-down check above.

---

## Supplying Policies

The SDK does not bundle any default affiliate network policies. You are responsible for supplying the policies relevant to your integration at construction time via `config.policies`.

Each `NetworkPolicy` defines the detection rules for one affiliate network. Policies are validated at initialization; invalid policies are skipped with a `console.warn`. If no policies are loaded, `checkForAffiliatePatterns` will always return no-match and the SDK will emit a `console.warn` to alert you.

```ts
import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';
import type { NetworkPolicy } from '@rakuten-rewards/standdown-sdk';

const CJ_POLICY: NetworkPolicy = {
  id: 'cj',
  schemaVersion: 2,
  policyVersion: 1,
  network: {
    id: 'cj',
    name: 'Commission Junction (CJ)',
    sessionDuration: 1_800_000, // 30 minutes
  },
  rules: [
    { domain: 'dpbolvw.net', reason: 'CJ primary click-tracking domain' },
    { domain: 'anrdoezrs.net', reason: 'CJ click-tracking domain variant' },
    { domain: 'jdoqocy.com', reason: 'CJ click-tracking domain variant' },
    { params: 'cjevent', reason: 'CJ event tracking parameter' },
  ],
};

const AFSRC_POLICY: NetworkPolicy = {
  id: 'generic-afsrc',
  schemaVersion: 2,
  policyVersion: 1,
  network: {
    id: 'afsrc',
    name: 'Generic Affiliate Source',
    sessionDuration: 1_800_000,
  },
  rules: [
    { params: 'afsrc', reason: 'Cross-network affiliate source parameter' },
  ],
};

const shield = new StanddownSDK({ policies: [CJ_POLICY, AFSRC_POLICY] });
```

See [INTEGRATION_GUIDE.md: Supplying Policies](./INTEGRATION_GUIDE.md#supplying-policies) for the full policy structure, rule matching semantics, and versioning fields.

---

## Inspecting Results

```ts
import type { DetectionResult, MatchedPattern } from '@rakuten-rewards/standdown-sdk';

const result: DetectionResult = shield.checkForAffiliatePatterns(tabId);

console.log(result.hasAffiliatePattern); // boolean
console.log(result.redirectChain);       // string[]: full URL chain observed
console.log(result.matchedPatterns);     // MatchedPattern[]

for (const match of result.matchedPatterns) {
  console.log(match.network); // e.g. "cj"
  console.log(match.url);     // URL in the chain that triggered the match
  console.log(match.rule);    // PolicyRule that matched
}
```

> **Privacy note:** `redirectChain` and `matchedPatterns` contain sensitive user navigation history. Do not log or transmit this data without explicit user consent. Keep access to `DetectionResult` within the background service worker; do not forward it to content scripts or web page contexts via a `chrome.runtime.onMessage` handler.

---

## Handling Your Own Affiliate Links

If your extension operates on one of the networks you have configured, `checkForAffiliatePatterns` will naturally detect your own affiliate links. Configure `ownAffiliatePatterns` at SDK construction to have the SDK automatically set `result.isOwnAffiliateLink`, then stand down only for competitors.

See [INTEGRATION_GUIDE.md: Handling Your Own Affiliate Links](./INTEGRATION_GUIDE.md#handling-your-own-affiliate-links) for per-network configuration patterns and a complete code walkthrough.

---

## Audit Log

The SDK includes an optional audit log that records affiliate detections to `chrome.storage.local`. Entries survive service worker restarts and expire per each network's `sessionDuration`. Enable with `StanddownSDK.create({ enableAuditLog: true, policies: [...] })`; the async factory hydrates in-memory state from storage before returning, so queries are accurate immediately after a restart.

> **Manifest permission:** Add `"storage"` to your `manifest.json` permissions array (see [Manifest V3 Permissions](#manifest-v3-permissions)).

See [INTEGRATION_GUIDE.md: Audit Log](./INTEGRATION_GUIDE.md#audit-log) for the full API, querying patterns, and guidance on when to use the audit log versus a custom in-memory session layer.

---

## TypeScript API Reference

### `StanddownSDK`

```ts
class StanddownSDK {
  /** Synchronous constructor. Does NOT hydrate the audit log from storage. */
  constructor(config?: StanddownSDKConfig);

  /**
   * Async factory. Hydrates the audit log from chrome.storage.local before
   * returning, so getEventLog() / getEventsByDomain() are accurate immediately.
   * Preferred when enableAuditLog is true.
   */
  static create(config?: StanddownSDKConfig): Promise<StanddownSDK>;

  checkForAffiliatePatterns(tabId: number): DetectionResult;

  /**
   * Removes all browser event listeners registered by this instance and clears
   * per-tab navigation state. Call this before discarding an SDK instance
   * (e.g. when re-creating with a new config) to prevent ghost listeners from
   * firing against stale state for the rest of the service worker lifetime.
   * No-op when the SDK was constructed without browser API access.
   */
  destroy(): void;

  /**
   * Returns all active (non-expired) audit log entries across every domain.
   * Throws if enableAuditLog was not set to true.
   */
  getEventLog(): AffiliateEvent[];

  /**
   * Returns active audit log entries for the given URL or bare hostname.
   * Normalises to root domain; returns [] when no active entry exists.
   * Throws if enableAuditLog was not set to true.
   */
  getEventsByDomain(input: string): AffiliateEvent[];
}
```

`checkForAffiliatePatterns`: inspects the URL chain observed for the given tab and returns a typed `DetectionResult`. Call this from your `webNavigation.onCompleted` / `onErrorOccurred` listener whenever you need to make a stand-down decision.

### `StanddownSDKConfig`

```ts
interface StanddownSDKConfig {
  /**
   * Affiliate network policies to use for detection.
   * Each policy is validated at initialization time; invalid policies are skipped
   * with console.warn. At least one valid policy with at least one valid rule is
   * required for checkForAffiliatePatterns() to return a match.
   */
  policies?: NetworkPolicy[];

  /**
   * Set to true to enable the audit log. Requires the "storage" manifest permission.
   * Use StanddownSDK.create() to ensure the log is hydrated from storage on startup.
   */
  enableAuditLog?: boolean;

  /**
   * Optional list of RegExp patterns identifying this extension's own publisher
   * parameters or path segments. All URLs in the redirect chain are tested
   * (not just the final URL), so publisher IDs embedded in intermediate hops
   * are handled correctly. OR semantics: any single match sets
   * result.isOwnAffiliateLink true.
   * See INTEGRATION_GUIDE.md: Handling Your Own Affiliate Links.
   */
  ownAffiliatePatterns?: RegExp[];
}
```

### `DetectionResult`

`DetectionResult` is a discriminated union. Narrow on `hasAffiliatePattern` to access match-specific fields safely:

```ts
const result = shield.checkForAffiliatePatterns(tabId);
if (result.hasAffiliatePattern) {
  const primary = result.matchedPatterns[0]; // always defined — non-empty tuple
  console.log(result.detectedAt);            // number (never null in this branch)
}
```

```ts
/** Returned when at least one affiliate pattern was detected. */
interface DetectionResultMatch {
  hasAffiliatePattern: true;
  /** Non-empty — guaranteed to have at least one entry. */
  matchedPatterns: [MatchedPattern, ...MatchedPattern[]];
  redirectChain: string[];
  /** Unix ms timestamp when the pattern was detected. */
  detectedAt: number;
  /** Unix ms expiry (Date.now() + longest matched sessionDuration). null when no matched policy defines a sessionDuration. */
  expiresAt: number | null;
  /** True when a pattern matched AND one of the configured ownAffiliatePatterns also matched a URL in the chain. Always false when ownAffiliatePatterns is unconfigured. */
  isOwnAffiliateLink: boolean;
}

/** Returned when no affiliate patterns were found. */
interface DetectionResultNoMatch {
  hasAffiliatePattern: false;
  matchedPatterns: [];   // always empty
  redirectChain: string[];
  detectedAt: null;
  expiresAt: null;
  isOwnAffiliateLink: false;
}

type DetectionResult = DetectionResultMatch | DetectionResultNoMatch;
```

### `AffiliateEvent`

```ts
interface AffiliateEvent {
  url: string;              // landing URL that triggered detection
  timestamp: number;        // Unix ms when detection occurred
  sessionDuration: number;  // ms until the session expires (from timestamp)
  matchedPatterns: MatchedPattern[];
  redirectChain: string[];
  isOwnAffiliateLink: boolean; // mirrors DetectionResult.isOwnAffiliateLink at detection time
}
```

### `MatchedPattern`

```ts
interface MatchedPattern {
  network: string;    // network.id of the matched policy
  rule: PolicyRule;   // the specific rule that matched
  url: string;        // URL in the chain that triggered the match
}
```

### `NetworkPolicy`

```ts
interface NetworkPolicy {
  id: string;
  schemaVersion: number;  // must be a supported version (currently 2)
  policyVersion: number;  // positive integer content version
  network: {
    id: string;
    name: string;
    description?: string;
    sessionDuration?: number; // milliseconds, e.g. 1_800_000 for 30 min
  };
  rules: PolicyRule[];
  metadata?: Record<string, unknown>;
}
```

### `PolicyRule`

```ts
interface PolicyRule {
  domain?: string;
  paths?: string | string[];
  params?: string | string[];
  pattern?: string;
  reason: string; // required: human-readable explanation
}
```

---

## Graceful Degradation

Ensure `webNavigation`, `webRequest`, and `tabs` are all declared in your `manifest.json` (see [Manifest V3 Permissions](#manifest-v3-permissions)). If `chrome.webNavigation` or `chrome.webRequest` is not available at construction time, the SDK logs a warning and initialises a no-op tracker. Affiliate detection will be silently disabled with no user-visible signal. All calls to `checkForAffiliatePatterns` return `{ hasAffiliatePattern: false, matchedPatterns: [], redirectChain: [], detectedAt: null, expiresAt: null, isOwnAffiliateLink: false }` until navigation events can be observed.

If no policies are provided (or all supplied policies fail validation), the SDK logs a `console.warn` at construction time: `[StanddownSDK] No policies loaded. checkForAffiliatePatterns() will always return no-match.` Ensure `config.policies` contains at least one valid policy before deploying.

---

## Security Considerations

### DetectionResult privacy

`DetectionResult` (including `redirectChain` and `matchedPatterns`) constitutes sensitive user navigation history. As the host extension you are responsible for:

- Not logging or transmitting this data without explicit user consent
- Keeping access scoped to the background service worker; do not expose it to content scripts or web page contexts via `chrome.runtime.onMessage`

### Custom policy `pattern` field (ReDoS)

Supplied `pattern` values are compiled to `RegExp` and evaluated against live navigation URLs. Patterns with nested quantifiers (e.g. `(a+)+`, `(x+x+)+y`) can cause catastrophic backtracking that hangs the service worker indefinitely. Always use bounded quantifiers and avoid nested repetition.

### Policy configuration trust model

Policies are supplied by your extension at initialization time and validated at load. Treat policy configuration as a privileged operation and do not expose it to untrusted or user-controlled input. Any caller who can supply a policy with a `pattern` field can execute a regex in the service worker context.

### Reporting vulnerabilities

To report a security issue, please contact the Rakuten Rewards security team via the process documented in [SECURITY.md](./SECURITY.md).

---

## License

MIT. See [LICENSE](./LICENSE).
