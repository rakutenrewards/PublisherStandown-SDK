# Integration Guide

This guide covers advanced integration scenarios for `@rakuten-rewards/standdown-sdk`. For the quick-start and API overview, see the [README](./README.md).

---

## Reference Implementation

Before reading this guide, look at `sample-extensions/session-manager/service-worker.js` in this repository. It is a complete, production-oriented service worker that demonstrates:

- SDK initialization with policies and `ownAffiliatePatterns`
- `webRequest.onCompleted` / `onErrorOccurred` listeners that trigger detection once navigation settles (including multi-hop redirect handling)
- A custom `SessionManager` for tracking affiliate sessions
- Cross-tab coordination via session state
- A `shouldStanddown` decision with a `reason` field (`'no_affiliate_detected'`, `'own_link'`, `'competitor_detected'`, `'session_active'`)

All patterns described in this guide are drawn from that implementation. Treat it as the canonical reference.

---

## Table of Contents

- [Reference Implementation](#reference-implementation)
- [Detection Modes: headers vs Navigation-Only](#detection-modes-headers-vs-navigation-only)
- [Supplying Policies](#supplying-policies)
  - [Policy structure](#policy-structure)
  - [Rule Matching Semantics](#rule-matching-semantics)
- [Cross-tab session management](#cross-tab-session-management)
  - [Background-tab activation pattern](#background-tab-activation-pattern)
  - [Implementing cross-tab coordination](#implementing-cross-tab-coordination)
- [Audit Log](#audit-log)
- [Handling Your Own Affiliate Links](#handling-your-own-affiliate-links)
  - [eBay Partner Network](#ebay-partner-network)
  - [Target (path-based publisher ID)](#target-path-based-publisher-id)
  - [Mixed networks](#mixed-networks)

---

## Detection Modes: headers vs Navigation-Only

The SDK operates in one of two modes depending on the browser it runs in. Mode selection is automatic; no configuration is required.

### Headers mode (Chrome, Firefox, Edge)

On Chrome, Firefox, and Edge, the SDK registers a `webRequest.onHeadersReceived` listener. It fires for every main-frame HTTP response, and the SDK uses the response status code to build the chain: 3xx responses are buffered as redirect hops, and the first non-3xx response (2xx/4xx/5xx) closes the chain. As a result, `redirectChain` in the detection result contains every URL from the initial affiliate click-tracking hop to the final merchant URL:

```
redirectChain: [
  'https://dpbolvw.net/click?...',   // affiliate network hop (3xx response)
  'https://www.merchant.com/',       // final destination (2xx response, closes the chain)
]
```

The SDK matches your policies against all URLs in the chain. This is the most complete detection mode, and it requires only the `webRequest` permission — `webNavigation` is **not** used on these browsers.

### Navigation-only mode (Safari)

Safari's `webRequest` stubs are callable but silently drop all listeners. The SDK detects this via `navigator.vendor` and uses `webNavigation.onBeforeNavigate` (as the buffer source) plus `webNavigation.onCommitted` (to settle the chain) instead.

In this mode, `onBeforeNavigate` fires for the initiating URL (the affiliate link the user clicked), but server-side redirect hops resolve invisibly inside the browser. `onCommitted` fires for the final committed URL. As a result, `redirectChain` contains only two entries:

```
redirectChain: [
  'https://dpbolvw.net/click?...',   // entry URL (caught by onBeforeNavigate)
  'https://www.merchant.com/',       // committed URL (caught by onCommitted)
]
```

The intermediate hops are not visible, but affiliate tracking parameters embedded in the entry URL or surviving to the committed URL are still matched normally. Most affiliate networks include enough identifiers in these two URLs for reliable detection. This mode requires the `webNavigation` permission.

### What this means for your integration

No code changes are required. The same `checkForAffiliatePatterns(tabId)` call works identically in both modes. The only observable difference is the length and content of `result.redirectChain`:

- On Chrome/Firefox/Edge, intermediate redirect hops are present.
- On Safari, only the entry URL and the committed URL are present.

If your integration inspects `redirectChain` directly (rather than relying on `hasAffiliatePattern` and `matchedPatterns`), be aware that chains will be shorter on Safari and intermediate hops will be absent.

---

## Supplying Policies

The SDK does not bundle any default affiliate network policies. You must supply the `NetworkPolicy` objects for every affiliate network you want to detect, passing them via `config.policies` at construction time.

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
    sessionDuration: 1_800_000, // 30 minutes in ms
  },
  rules: [
    { domain: 'dpbolvw.net', reason: 'CJ primary click-tracking domain' },
    { domain: 'anrdoezrs.net', reason: 'CJ click-tracking domain variant' },
    { domain: 'jdoqocy.com', reason: 'CJ click-tracking domain variant' },
    { domain: 'tkqlhce.com', reason: 'CJ click-tracking domain variant' },
    { params: 'cjevent', reason: 'CJ event tracking parameter on destination URL' },
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

Each policy is validated at initialization time. Invalid policies (missing required fields, unsupported `schemaVersion`, invalid rules) are skipped with a `console.warn`. If no valid policies are loaded, the SDK emits a `console.warn` and `checkForAffiliatePatterns` will always return no-match.

### Policy structure

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique identifier for this policy (e.g. `"cj"`). |
| `schemaVersion` | `number` | Yes | Must be `2`. Policies with an unrecognised version are rejected at load time. |
| `policyVersion` | `number` | Yes | Positive integer content version. Increment when detection behaviour changes substantially. |
| `network.id` | `string` | Yes | Short machine-readable network identifier. Appears as `match.network` in `DetectionResult`. |
| `network.name` | `string` | Yes | Human-readable network name. |
| `network.sessionDuration` | `number` | No | How long an affiliate session should be honoured, in milliseconds. Used to compute `result.expiresAt`. Defaults to 30 minutes if omitted. |
| `rules` | `PolicyRule[]` | Yes | Detection rules for this network. |
| `metadata` | `object` | No | Freeform metadata (e.g. `lastUpdated`, `documentation`). Not used by the SDK. |

### Rule Matching Semantics

Within a single rule, all present fields must match (AND semantics, evaluated in this order):

| Field | Matches when |
|-------|-------------|
| `domain` | Hostname equals the value exactly, or is a subdomain of it (case-insensitive) |
| `paths` | URL pathname starts with any entry in the array (OR semantics) |
| `params` | URL has any of the listed query parameter names (OR semantics) |
| `pattern` | Full URL matches the regex string (compiled case-insensitively at load time) |

Across the full redirect chain, **all** per-URL matches are collected. Per URL, the **first** matching rule wins (early exit for that URL only).

> **ReDoS warning:** The `pattern` field must not use constructs that cause catastrophic backtracking (e.g. `(a+)+`, `(x+x+)+y`). The SDK runs inside a single-threaded service worker; a hung regex will block the entire event loop. Always use bounded quantifiers and avoid nested repetition.

---

## Cross-tab session management

### Background-tab activation pattern

The classical affiliate activation model works like this: a user clicks an affiliate link, their browser follows a redirect chain through the network's click-tracking hop, and they arrive at the merchant page with the affiliate session attributed in the URL (e.g. via query parameters or cookies). `checkForAffiliatePatterns(tabId)` on the user's current tab captures this chain directly.

Some extensions use a different model: they open a **background tab**, navigate it through the affiliate network's redirect chain to set the affiliate cookies on the merchant domain, and then close it. The user's visible tab never participates in the redirect; it simply loads the merchant page directly and inherits the cookie-based session that was established in the background. Because the visible tab saw no affiliate redirect, calling `checkForAffiliatePatterns` on it returns no match.

This creates a gap: the tab that carries evidence of the affiliate activation (the background tab) is closed before the user ever arrives at the merchant. The only way to bridge this gap is to **monitor all navigations on all tabs**, detect the activation on the background tab while it is still open, record that activation, and then check the recorded state when the user's visible tab subsequently loads the merchant page.

The SDK observes every tab automatically; you do not need to filter to visible tabs. Call `checkForAffiliatePatterns` in a `webRequest.onCompleted` listener that runs for every tab, capture any match, and store it against the merchant domain. (`webRequest.onCompleted` fires after the final response, by which point the SDK's tracker has finalised the chain, and it needs no permission beyond `webRequest`. If you already declare `webNavigation`, `webNavigation.onCompleted` works too.)

```ts
import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';

const shield = new StanddownSDK({ policies: MY_POLICIES });

// Resolve the webRequest namespace the same way the SDK does internally
// (browser on Firefox/Safari, chrome on Chrome/Edge).
const webRequest = globalThis.browser?.webRequest ?? chrome.webRequest;
const MAIN_FRAME = { urls: ['<all_urls>'], types: ['main_frame'] as chrome.webRequest.ResourceType[] };

// Monitor ALL tabs; the background tab that carries the affiliate redirect
// will be caught here before it closes.
webRequest.onCompleted.addListener(({ tabId }) => {
  if (tabId < 0) return;
  const result = shield.checkForAffiliatePatterns(tabId);
  if (!result.hasAffiliatePattern) return;
  recordActivation(result); // store against merchant domain for later lookup
}, MAIN_FRAME);
```

### Implementing cross-tab coordination

Detecting the background activation is only half the work. When the user's visible tab later loads the same merchant, you need to look up whether a prior activation was recorded for that domain and act on it. This lookup-and-decide flow is what constitutes a **session** in this model.

The SDK does not manage this session state; it only answers "did this tab see an affiliate redirect?" Your extension is responsible for building the bridge: record activations keyed by merchant domain, and query that record when a new tab reaches the same domain. A few design decisions to make:

- **Scope:** Should the suppression apply per-domain, or globally across all tabs?
- **Duration:** How long should a recorded activation remain active? Until the first matching tab loads? For a fixed TTL?
- **Domain keying:** How do you normalize merchant domains? (`shop.example.com` and `www.example.com` should typically resolve to the same key.)

The pattern below is a starting point. It records activations by merchant hostname and checks them when any tab finishes loading:

```ts
import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';

const shield = new StanddownSDK({ policies: MY_POLICIES });

// Simple in-memory record: merchant hostname → detected networks
const pendingActivations = new Map<string, string[]>();

// Resolve the webRequest namespace (browser on Firefox/Safari, chrome on Chrome/Edge).
const webRequest = globalThis.browser?.webRequest ?? chrome.webRequest;
const MAIN_FRAME = { urls: ['<all_urls>'], types: ['main_frame'] as chrome.webRequest.ResourceType[] };

// Monitor ALL tabs in a single listener.
// On every completed navigation:
//   1. Check if this tab (possibly background) saw an affiliate redirect → record it.
//   2. Check if a prior activation was recorded for the merchant this tab just loaded → stand down.
webRequest.onCompleted.addListener(({ tabId, url }) => {
  if (tabId < 0) return;

  const result = shield.checkForAffiliatePatterns(tabId);
  if (result.hasAffiliatePattern) {
    // Record the activation keyed by the merchant page at the end of the redirect chain.
    for (const match of result.matchedPatterns) {
      try {
        const merchant = new URL(result.redirectChain[result.redirectChain.length - 1]).hostname;
        const existing = pendingActivations.get(merchant) ?? [];
        if (!existing.includes(match.network)) {
          pendingActivations.set(merchant, [...existing, match.network]);
        }
      } catch { /* malformed URL */ }
    }
  }

  // Check whether a background activation was recorded for the merchant this tab just loaded.
  try {
    const hostname = new URL(url).hostname;
    const networks = pendingActivations.get(hostname);
    if (networks) {
      // A competing network already owns this merchant session; stand down.
      pendingActivations.delete(hostname); // consume: one stand-down per activation
      markTabAsStanddown(tabId, networks);
    }
  } catch { /* malformed URL */ }
}, MAIN_FRAME);
```

> **Session management is your responsibility.** The example above uses a simple consume-once model: the first tab to load the merchant after a background activation is suppressed, and the record is cleared. A production implementation will need more: TTL-based expiry so stale records don't accumulate, root-domain normalization so `shop.example.com` and `www.example.com` resolve to the same key, and per-domain LRU eviction to bound memory. See `sample-extensions/session-manager/session-manager.js` for a reference implementation of a `SessionManager` class with all of these properties, and `service-worker.js` in the same directory for how it is wired into the navigation listeners.

---

## Audit Log

The SDK includes an optional audit log that records affiliate detections to `chrome.storage.local`. When enabled, every call to `checkForAffiliatePatterns` that returns a match is automatically recorded with no extra code needed. Entries are keyed by root domain, survive service worker restarts, and expire after each network's `sessionDuration` elapses.

### Enabling the Audit Log

Use the async factory `StanddownSDK.create()` to instantiate the SDK with the audit log enabled. The factory hydrates in-memory state from `chrome.storage.local` before returning, so `getEventLog()` and `getEventsByDomain()` return accurate results immediately, even after a service worker restart.

```ts
import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';

// Instantiate once at service worker startup.
const shield = await StanddownSDK.create({ policies: MY_POLICIES, enableAuditLog: true });
```

> **Manifest permission:** Add `"storage"` to your `manifest.json` `permissions` array alongside your navigation permissions (`"webRequest"` + `"tabs"` on Chrome/Firefox/Edge, or `"webNavigation"` + `"tabs"` on Safari).

> **Top-level await caveat:** Chrome MV3 service workers can idle-terminate between events. If your extension must handle its very first navigation event after a cold start, consider wiring listeners before awaiting `create()`, or initialising synchronously with `new StanddownSDK({ policies: MY_POLICIES, enableAuditLog: true })` and accepting that the in-memory log will not contain entries from before the last restart until storage hydration completes asynchronously.

### Querying the Audit Log

```ts
import type { AffiliateEvent } from '@rakuten-rewards/standdown-sdk';

// All active (non-expired) entries across every domain
const log: AffiliateEvent[] = shield.getEventLog();

// Entries for a specific domain; accepts a full URL or a bare hostname
const events: AffiliateEvent[] = shield.getEventsByDomain('https://www.example.com/');
// or:
const events2: AffiliateEvent[] = shield.getEventsByDomain('example.com');

for (const event of events) {
  console.log(event.url);              // landing URL that triggered detection
  console.log(event.timestamp);        // Unix ms when detection occurred
  console.log(event.sessionDuration);  // ms until the session expires
  console.log(event.matchedPatterns);  // MatchedPattern[]: same shape as DetectionResult
  console.log(event.redirectChain);    // string[]: full URL chain observed
  console.log(event.isOwnAffiliateLink); // boolean: mirrors DetectionResult at detection time
}
```

`getEventsByDomain()` normalises the input to a root domain (e.g. `shop.example.com` → `example.com`) and returns `[]` when no active entry exists for that domain. It throws if the audit log was not enabled at construction time.

### Session Expiry

Entries expire after the matched network's `sessionDuration` (defined on `NetworkPolicy.network.sessionDuration`, in milliseconds). Expiry is checked lazily; an entry is only pruned when it is read. To force a full sweep, call `getEventLog()`.

### When the audit log is useful

The audit log is most useful when your extension needs to know whether a prior affiliate session exists for a domain **after a service worker restart**, where an in-memory session store would have been wiped. If the user visits a merchant, closes their browser, reopens it, and navigates back to the same merchant, an in-memory `SessionManager` has no record of the prior visit; the audit log does.

It can also simplify integrations that only need to answer "has this domain been activated recently?" without building a full session management layer. Rather than maintaining a `Map` of activations yourself, you delegate recording and expiry to the SDK and query on demand.

### When to use a custom session layer instead

If your stand-down logic requires more than a simple domain lookup (for example, pairing background-tab activations to visible tabs, combining live detection with prior session state, or applying custom expiry rules), a custom `SessionManager` (as shown in [Cross-tab session management](#cross-tab-session-management)) gives you more control. The two approaches are not mutually exclusive: you can enable the audit log for persistence while also maintaining in-memory state for real-time coordination.

`sample-extensions/audit-log/service-worker.js` demonstrates the audit log pattern in a complete extension.

---

## Handling Your Own Affiliate Links

If your extension operates on one of the networks you have configured, `checkForAffiliatePatterns` will naturally detect your own affiliate links. The correct approach is to **keep all policies active** and use `result.isOwnAffiliateLink` to distinguish your links from competitors'.

### Configuring `ownAffiliatePatterns`

Pass your publisher-specific identifiers as `RegExp` patterns when creating the SDK. The SDK tests every URL in the redirect chain against your patterns and sets `result.isOwnAffiliateLink` automatically.

```ts
import { StanddownSDK } from '@rakuten-rewards/standdown-sdk';

// Replace these with the publisher-specific parameters assigned to YOUR extension
// by each affiliate network. The values below are fictional examples.
//
// How to find your identifiers:
//   CJ:   Account Settings → Publisher IDs → m_si (site ID), m_pl (publisher label)
//   eBay: Partner Network dashboard → Custom ID / tracking ID
//   Other networks: inspect landing-page URLs after a test click for unique params
const shield = new StanddownSDK({
  policies: MY_POLICIES,
  ownAffiliatePatterns: [
    /m_pl=YourExtension/,  // CJ: publisher label
    /[?&]m_si=12345/i,     // CJ: publisher site ID
    /customid=yourextid/,  // eBay Partner Network: custom tracking ID
    // For networks with publisher ID in an intermediate hop's path:
    // /goto\.target\.com\/c\/12345\//,
  ],
});

// In your message handler: stand down only for competitors, not own links.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CHECK_STANDDOWN') return false;

  const tabId = sender.tab?.id;
  if (tabId == null) return false;

  const result = shield.checkForAffiliatePatterns(tabId);

  sendResponse({
    shouldStanddown: result.hasAffiliatePattern && !result.isOwnAffiliateLink,
  });
  return true;
});
```

All URLs in the redirect chain are tested, not just the final URL, so publisher IDs embedded in intermediate hops are handled correctly. The SDK applies OR semantics across all patterns and all URLs: any single match sets `result.isOwnAffiliateLink: true`.

> **Manual approach (fallback):** If you need to determine own-link status outside of the SDK (e.g. based on context not available at construction time), inspect `result.redirectChain` and `result.matchedPatterns` directly and apply your own logic.

### eBay Partner Network

eBay injects a `customid` query parameter on the destination URL. Use a regex that matches the parameter and your specific value:

```ts
/customid=yourextid/   // matches ?customid=yourextid anywhere in the URL
```

For exact parameter matching (avoids partial matches like `customid=yourextid2`):

```ts
/[?&]customid=yourextid(?:&|$)/
```

### Target (path-based publisher ID)

Target affiliate links route through `goto.target.com`, where the publisher ID appears as a path segment (e.g. `/c/12345/`). Because this ID is on an intermediate hop (not the final destination URL), a path regex is required. The SDK tests all URLs in the chain, so this is handled correctly:

```ts
/goto\.target\.com\/c\/12345\//   // matches the intermediate hop with your publisher ID
```

### Mixed networks

Configure all your per-network patterns in a single `ownAffiliatePatterns` array:

```ts
const shield = new StanddownSDK({
  policies: MY_POLICIES,
  ownAffiliatePatterns: [
    /m_pl=YourExtension/,           // CJ: publisher label
    /[?&]m_si=12345/i,              // CJ: publisher site ID
    /customid=yourextid/,           // eBay Partner Network
    /goto\.target\.com\/c\/12345\//, // Target: path-based publisher ID (intermediate hop)
  ],
});
```
