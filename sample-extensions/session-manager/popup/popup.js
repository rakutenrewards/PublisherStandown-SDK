/**
 * Standdown SDK: Session Manager Sample Extension, Popup Script
 *
 * On open: queries the active tab (or a tabId provided via URL param),
 * sends CHECK_STANDDOWN to the service worker, and renders the result
 * across three labeled sections:
 *
 *   ON-DEMAND CHECK: SDK DetectionResult snapshot for this tab's current navigation
 *   DECISION: computed shouldStanddown + reason from the service worker
 *   SESSION: live session state for this domain; updates via push events
 *                     so a background-tab detection is reflected in real time
 *
 * URL param usage (for Playwright tests):
 *   popup.html?tabId=42  → checks tab 42 directly, bypassing active-tab query
 */

const onDemandSectionEl = document.getElementById('on-demand-section');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const sessionStatusEl = document.getElementById('session-status');
const sessionTimestampEl = document.getElementById('session-timestamp');
const sessionDetectionEl = document.getElementById('session-detection');
const sessionTabEl = document.getElementById('session-tab');
const redirectChainSectionEl = document.getElementById('redirect-chain-section');
const redirectChainEl = document.getElementById('redirect-chain');
const matchedPatternsSectionEl = document.getElementById('matched-patterns-section');
const matchedPatternsEl = document.getElementById('matched-patterns');
const decisionStatusEl = document.getElementById('decision-status');
const decisionReasonEl = document.getElementById('decision-reason');

/** The tabId this popup is watching; set once on load and reused by the push listener. */
let currentTabId = null;

/** Display a DetectionResult in the ON-DEMAND CHECK section. */
function displayResult(result) {
  if (result.hasAffiliatePattern) {
    if (result.isOwnAffiliateLink) {
      statusEl.textContent = '✓ Own affiliate link; no stand-down';
      statusEl.className = 'clean';
    } else {
      statusEl.textContent = '⚠ Competitor affiliate detected';
      statusEl.className = 'match';
    }
  } else {
    statusEl.textContent = '✓ No affiliate pattern';
    statusEl.className = 'clean';
  }
  // Expose structured data attributes for Playwright assertions
  resultEl.dataset.hasAffiliatePattern = String(result.hasAffiliatePattern);
  resultEl.dataset.networkCount = String(result.matchedPatterns.length);
  resultEl.dataset.isOwnAffiliateLink = String(result.isOwnAffiliateLink ?? false);
  const sdkResult = {
    hasAffiliatePattern: result.hasAffiliatePattern,
    matchedPatterns: result.matchedPatterns,
    redirectChain: result.redirectChain,
    detectedAt: result.detectedAt ?? null,
    expiresAt: result.expiresAt ?? null,
    isOwnAffiliateLink: result.isOwnAffiliateLink,
  };
  resultEl.textContent = JSON.stringify(sdkResult, null, 2);
}

/**
 * Display the service-worker's computed stand-down decision in the DECISION section.
 *
 * @param {{ shouldStanddown: boolean, reason: string }} result
 */
function displayDecision(result) {
  if (result.shouldStanddown) {
    decisionStatusEl.textContent = 'Stand down';
    decisionStatusEl.className = 'standdown';
  } else {
    decisionStatusEl.textContent = 'No stand-down';
    decisionStatusEl.className = 'no-standdown';
  }
  decisionReasonEl.textContent = result.reason ?? '';
}

/**
 * Returns the rule type string for a PolicyRule object.
 * Rule type is determined by which key is present: domain, paths, params, or pattern.
 *
 * @param {object} rule
 * @returns {string}
 */
function getRuleType(rule) {
  if ('domain' in rule) return 'domain';
  if ('paths' in rule) return 'paths';
  if ('params' in rule) return 'params';
  if ('pattern' in rule) return 'pattern';
  return 'unknown';
}

/**
 * Render the redirect chain into #redirect-chain as an ordered list.
 *
 * @param {string[]} chain
 */
function renderRedirectChain(chain) {
  redirectChainEl.innerHTML = '';
  for (const url of chain) {
    const li = document.createElement('li');
    li.textContent = url;
    redirectChainEl.appendChild(li);
  }
  redirectChainSectionEl.style.display = chain.length > 0 ? '' : 'none';
}

/**
 * Render matched patterns into #matched-patterns.
 * Each entry shows: network name, matched URL, and rule type.
 *
 * @param {Array<{ network: string, url: string, rule: object }>} patterns
 */
function renderMatchedPatterns(patterns) {
  matchedPatternsEl.innerHTML = '';

  if (patterns.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#888';
    empty.textContent = 'No matches';
    matchedPatternsEl.appendChild(empty);
    matchedPatternsSectionEl.style.display = '';
    return;
  }

  for (const match of patterns) {
    const entry = document.createElement('div');
    entry.className = 'match-entry';

    const network = document.createElement('div');
    network.className = 'match-network';
    network.textContent = `[${match.network}]`;

    const url = document.createElement('div');
    url.className = 'match-url';
    url.textContent = match.url;

    const rule = document.createElement('div');
    rule.className = 'match-rule';
    rule.textContent = `Rule: ${getRuleType(match.rule)}`;

    entry.appendChild(network);
    entry.appendChild(url);
    entry.appendChild(rule);
    matchedPatternsEl.appendChild(entry);
  }
  matchedPatternsSectionEl.style.display = '';
}

/**
 * Display the session state for the current tab's domain in the SESSION section.
 *
 * When a session is active, shows the expiry time, the tab that triggered the
 * session, and the redirect chain + matched patterns from the detection event
 * that created it.
 *
 * Updates live via AFFILIATE_DETECTED_PUSH so a background-tab detection is
 * reflected without the user needing to reopen the popup.
 *
 * @param {{ detectedAt: number, expiresAt: number | null, tabId: number,
 *           result: { redirectChain: string[], matchedPatterns: object[] } } | null} session
 */
function displaySessionState(session) {
  onDemandSectionEl.style.display = session ? 'none' : '';

  if (session) {
    sessionStatusEl.textContent = 'Session active';
    sessionStatusEl.className = 'session-active';
    sessionTimestampEl.textContent = session.expiresAt !== null
      ? `Expires: ${new Date(session.expiresAt).toLocaleTimeString()}`
      : '';
    sessionTabEl.textContent = `Triggered by tab ${session.tabId}`;
    sessionDetectionEl.style.display = '';
    renderRedirectChain(session.result.redirectChain ?? []);
    renderMatchedPatterns(session.result.matchedPatterns ?? []);
  } else {
    sessionStatusEl.textContent = 'No session';
    sessionStatusEl.className = 'session-none';
    sessionTimestampEl.textContent = '';
    sessionDetectionEl.style.display = 'none';
    redirectChainSectionEl.style.display = 'none';
    matchedPatternsSectionEl.style.display = 'none';
  }
}

function displayError(msg) {
  statusEl.textContent = `Error: ${msg}`;
  statusEl.className = '';
  resultEl.textContent = '';
  decisionStatusEl.textContent = '';
  decisionStatusEl.className = '';
  decisionReasonEl.textContent = '';
  sessionDetectionEl.style.display = 'none';
  displaySessionState(null);
}

function checkTab(tabId) {
  currentTabId = tabId;
  chrome.runtime.sendMessage({ type: 'CHECK_STANDDOWN', tabId }, (result) => {
    if (chrome.runtime.lastError) {
      displayError(chrome.runtime.lastError.message ?? 'unknown');
      return;
    }
    displayResult(result);
    displayDecision(result);
    // result.session is the session record for this tab's domain, or null.
    displaySessionState(result.session ?? null);
  });
}

// Support explicit tabId via URL search param (for automated tests)
const params = new URLSearchParams(location.search);
const explicitTabId = params.get('tabId');

if (explicitTabId !== null) {
  checkTab(parseInt(explicitTabId, 10));
} else {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id == null) {
      displayError('No active tab found');
      return;
    }
    checkTab(tab.id);
  });
}

// Live update: when any affiliate detection fires (any tab), re-query the
// standdown state for the tab this popup is watching. This is how a background
// tab establishing a session propagates in real time to this popup.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'AFFILIATE_DETECTED_PUSH') return;
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: 'CHECK_STANDDOWN', tabId: currentTabId }, (result) => {
    if (chrome.runtime.lastError) return;
    displayDecision(result);
    displaySessionState(result.session ?? null);
  });
});
