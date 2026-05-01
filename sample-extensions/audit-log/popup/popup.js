/**
 * Standdown SDK: Audit Log Sample Extension, Popup Script
 *
 * Sends CHECK_AUDIT to the service worker, which queries
 * sdk.getEventsByDomain(tab.url) and responds with { event, triggerTabId }
 * or null when no active session exists for this domain.
 *
 * The popup also listens for AFFILIATE_DETECTED_PUSH so it updates in real
 * time when a detection fires, including from a background tab on the same
 * root domain.
 *
 * URL param usage (for Playwright tests):
 *   popup.html?tabId=42  → checks tab 42 directly, bypassing active-tab query
 */

const statusEl = document.getElementById('status');
const eventNoneEl = document.getElementById('event-none');
const eventDetailsEl = document.getElementById('event-details');
const domainEl = document.getElementById('event-domain');
const timestampEl = document.getElementById('event-timestamp');
const expiresEl = document.getElementById('event-expires');
const networksEl = document.getElementById('event-networks');
const eventTabEl = document.getElementById('event-tab');
const redirectChainSectionEl = document.getElementById('redirect-chain-section');
const redirectChainEl = document.getElementById('redirect-chain');
const matchedPatternsSectionEl = document.getElementById('matched-patterns-section');
const matchedPatternsEl = document.getElementById('matched-patterns');
const rawEl = document.getElementById('event-raw');

/** The tabId this popup is watching; set once on load and reused by the push listener. */
let currentTabId = null;

/**
 * Returns the rule type string for a PolicyRule object.
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
 * Render the audit log event (or null) into the popup UI.
 * Called by render() on load and by the push listener on live updates.
 *
 * @param {{ event: object, triggerTabId: number | null } | null} response
 */
function displayEvent(response) {
  if (!response) {
    statusEl.textContent = 'No active affiliate session';
    statusEl.className = 'clean';
    eventNoneEl.style.display = '';
    eventDetailsEl.style.display = 'none';
    rawEl.textContent = 'null';
    return;
  }

  const { event, triggerTabId } = response;

  statusEl.textContent = 'Active affiliate session';
  statusEl.className = 'match';
  eventNoneEl.style.display = 'none';
  eventDetailsEl.style.display = '';

  const url = new URL(event.url);
  domainEl.textContent = url.hostname;
  timestampEl.textContent = new Date(event.timestamp).toLocaleString();
  expiresEl.textContent = new Date(event.timestamp + event.sessionDuration).toLocaleString();
  networksEl.textContent = [...new Set(event.matchedPatterns.map((p) => p.network))].join(', ');
  eventTabEl.textContent = triggerTabId != null ? `Tab ${triggerTabId}` : '—';
  renderRedirectChain(event.redirectChain ?? []);
  renderMatchedPatterns(event.matchedPatterns ?? []);
  rawEl.textContent = JSON.stringify(event, null, 2);
}

async function render() {
  // Resolve tabId: explicit URL param (Playwright tests) or active tab.
  const params = new URLSearchParams(location.search);
  const explicitTabId = params.get('tabId');

  if (explicitTabId !== null) {
    currentTabId = parseInt(explicitTabId, 10);
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      statusEl.textContent = 'No active tab';
      statusEl.className = 'clean';
      return;
    }
    currentTabId = tab.id;
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'CHECK_AUDIT', tabId: currentTabId });
  } catch {
    statusEl.textContent = 'Error querying audit log';
    statusEl.className = 'clean';
    return;
  }

  displayEvent(response ?? null);
}

render().catch((err) => {
  if (statusEl) {
    statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    statusEl.className = 'clean';
  }
});

// Live update: when any affiliate detection fires, re-query the audit log for
// the tab this popup is watching. Handles background-tab detections on the
// same root domain updating the display in real time.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'AFFILIATE_DETECTED_PUSH') return;
  if (currentTabId == null) return;
  chrome.runtime.sendMessage({ type: 'CHECK_AUDIT', tabId: currentTabId }, (response) => {
    if (chrome.runtime.lastError) return;
    displayEvent(response ?? null);
  });
});
