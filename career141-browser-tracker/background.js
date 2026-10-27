import { newState, domainOf, dayKey, settle, prune } from './core.js';

let queue = Promise.resolve();
let lastUploadAttempt = 0;
let signingIn = false;

async function signIn(message) {
  if (message.consent !== true) throw new Error('Accept the tracking notice before starting.');
  const email = String(message.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@career141\.com$/.test(email)) throw new Error('Use your Career141 email address.');
  const origin = systemOrigin(message.origin);
  const { pairing: existing } = await chrome.storage.local.get('pairing');
  if (existing?.email === email && existing.origin === origin && !existing.needsSignIn) return serial(() => checkpoint({ type: 'start', consent: true }));
  if ((await read()).enabled) throw new Error('Pause tracking before signing in to a different account.');
  if (signingIn) throw new Error('Connecting your account. Please wait.');
  signingIn = true;
  try {
    // Verify the existing TA website session without opening another window.
    // Only the hash leaves the extension; the private credential stays here.
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    const tab = tabs.find(tab => !tab.incognito && tab.id && tab.url && new URL(tab.url).origin === origin);
    if (!tab) throw new Error(`Open ${origin} and sign in with ${email}, then choose Start tracking here.`);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (request) => {
        try {
          const response = await fetch('/api/ta-track', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request), signal: AbortSignal.timeout(15000)
          });
          const data = await response.json();
          return { ok: response.ok && data.ok === true, error: data.error };
        } catch { return { ok: false, error: 'Could not connect to the TA system. Check the website and try again.' }; }
      },
      args: [{ email, tokenHash }]
    });
    if (!results[0]?.result?.ok) throw new Error(results[0]?.result?.error || 'Sign in to the TA website with this email, then choose Start tracking.');
    const pairing = { origin, email, token, sent: {}, lastSyncAt: 0, error: '' };
    const account = await upload(pairing, [], false);
    if (account.email !== email) throw new Error('The signed-in account does not match your Career141 email.');
    return await serial(async () => {
      const previous = await read();
      if (previous.enabled) throw new Error('Pause tracking before changing the account connection.');
      const tracker = newState(); tracker.name = account.name;
      await chrome.storage.local.set({ pairing, tracker, previousTracker: previous });
      return checkpoint({ type: 'start', consent: true });
    });
  } finally { signingIn = false; }
}

function systemOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Use an HTTPS TA system address, or localhost for development.');
  return url.origin;
}

async function upload(pairing, rows, enabled) {
  const response = await fetch(`${pairing.origin}/api/ta-track/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.token}` },
    body: JSON.stringify({ rows, enabled }), signal: AbortSignal.timeout(10000), credentials: 'omit', redirect: 'error'
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || 'Could not upload tracking data.');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function sync(state, force = false) {
  const { pairing } = await chrome.storage.local.get('pairing');
  if (!pairing || (!force && Date.now() - lastUploadAttempt < 30000)) return;
  lastUploadAttempt = Date.now();
  const { previousTracker } = await chrome.storage.local.get('previousTracker');
  if (previousTracker) {
    prune(previousTracker, Date.now());
    await chrome.storage.local.set({ previousTracker });
  }
  try {
    const sent = pairing.sent || {};
    const entries = Object.entries(state.rows).filter(([key, row]) => sent[key] !== row.lastSeen);
    // An empty upload still reports pause/start and confirms the connection.
    for (let offset = 0; offset < Math.max(entries.length, 1); offset += 200) {
      const batch = entries.slice(offset, offset + 200);
      await upload(pairing, batch.map(([, { name, ...row }]) => row), state.enabled);
      for (const [key, row] of batch) sent[key] = row.lastSeen;
    }
    pairing.sent = Object.fromEntries(Object.keys(state.rows).filter(key => sent[key] !== undefined).map(key => [key, sent[key]]));
    pairing.lastSyncAt = Date.now(); pairing.error = ''; pairing.needsSignIn = false;
  } catch (error) {
    pairing.error = error.message || 'Upload failed. Will retry automatically.';
    if (error.status === 401) pairing.needsSignIn = true;
  }
  await chrome.storage.local.set({ pairing });
}
function serial(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error('Tracker:', error));
  return result;
}

async function read() {
  const state = (await chrome.storage.local.get('tracker')).tracker || newState();
  const { pairing } = await chrome.storage.local.get('pairing');
  // Older local-pilot versions could be ON with only a typed name. Updating
  // must unlock email sign-in without deleting their existing activity.
  if (state.enabled && (!pairing?.email || !pairing.token)) {
    state.enabled = false;
    state.consent = false;
    state.cursor = null;
    await chrome.storage.local.set({ tracker: state });
  }
  return state;
}

async function selected() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const win = windows.find(item => item.focused && !item.incognito);
  if (!win) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  const domain = tab && !tab.incognito && domainOf(tab.url);
  return domain ? { tabId: tab.id, domain } : null;
}

async function badge(state) {
  await chrome.action.setBadgeText({ text: state.enabled ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#157347' });
  await chrome.action.setTitle({ title: state.enabled ? 'TA tracking ON — click to pause' : 'TA tracking paused' });
}

async function checkpoint(command, sender) {
  const state = await read();
  const now = Date.now();
  settle(state, now);
  prune(state, now);
  let tab = await selected();

  if (command?.type === 'start') {
    const { pairing } = await chrome.storage.local.get('pairing');
    if (!pairing?.email || !pairing.token || !state.name || command.consent !== true) throw new Error('Connect your TA account and accept the tracking notice.');
    state.consent = true;
    state.enabled = true;
  }
  if (command?.type === 'pause') state.enabled = false;
  if (command?.type === 'clear') {
    Object.assign(state, newState());
  }

  const idle = await chrome.idle.queryState(60);
  if (state.enabled && tab) {
    state.cursor = { ...tab, at: now, active: idle === 'active' };
    // Validate sender and foreground tab; never trust page-provided URLs.
    if (command?.type === 'activity' && idle === 'active' && sender?.tab?.id === tab.tabId && !sender.tab.incognito && domainOf(sender.url) === tab.domain) {
      const key = JSON.stringify([dayKey(now), state.name, tab.domain]);
      const row = state.rows[key] ||= {
        date: dayKey(now), name: state.name, domain: tab.domain,
        foregroundMs: 0, activeMs: 0, idleMs: 0,
        clicks: 0, scrolls: 0, movementSeconds: 0, lastSeen: now
      };
      for (const field of ['clicks', 'scrolls', 'movementSeconds']) {
        const value = Number(command[field]);
        row[field] += Number.isFinite(value) ? Math.max(0, Math.min(field === 'movementSeconds' ? 30 : 1000, Math.floor(value))) : 0;
      }
      row.lastSeen = now;
    }
  }
  state.updatedAt = now;
  await chrome.storage.local.set({ tracker: state });
  await badge(state);
  await sync(state, command?.type === 'start' || command?.type === 'pause');
  return state;
}

function tick() { serial(() => checkpoint()).catch(() => {}); }
chrome.tabs.onActivated.addListener(tick);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url || change.status === 'complete') tick(); });
chrome.tabs.onRemoved.addListener(tick);
chrome.windows.onFocusChanged.addListener(tick);
chrome.idle.onStateChanged.addListener(tick);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'checkpoint') tick(); });

async function initialize() {
  await chrome.idle.setDetectionInterval(60);
  await chrome.alarms.create('checkpoint', { periodInMinutes: 0.5 });
  // Across browser restarts the previous foreground state is unknown.
  const state = await read();
  state.cursor = null;
  await chrome.storage.local.set({ tracker: state });
  return checkpoint();
}
chrome.runtime.onInstalled.addListener(() => { serial(initialize).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { serial(initialize).catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const page = sender.url || '';
  const trustedUI = page === chrome.runtime.getURL('popup.html');
  if (!message || (message.type !== 'activity' && !trustedUI)) return false;
  if (message.type === 'sign-in' && trustedUI) {
    signIn(message).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (!['activity', 'start', 'pause', 'status'].includes(message.type)) return false;
  serial(() => checkpoint(message, sender))
    .then(state => sendResponse({ ok: true, ...(message.type === 'activity' ? {} : { state }) }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
