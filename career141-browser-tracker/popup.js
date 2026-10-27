const $ = id => document.getElementById(id);
async function send(payload) {
  $('error').textContent = '';
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) throw new Error(response?.error || 'Could not reach tracker.');
    const state = response.state;
    const { pairing } = await chrome.storage.local.get('pairing');
    const connected = Boolean(pairing?.email && pairing.token);
    const tracking = connected && state.enabled;
    $('status').textContent = tracking ? `Tracking ON · ${state.name}` : connected ? 'Tracking paused' : 'Sign in to start tracking';
    $('account').textContent = connected ? `Signed in as ${pairing.email}` : 'Enter your Career141 email below.';
    $('origin').value = pairing?.origin || $('origin').value;
    if (!pairing?.origin && payload.type === 'status') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        const url = new URL(tab.url);
        if (['localhost', '127.0.0.1'].includes(url.hostname) && (url.pathname === '/ta-track' || url.pathname.startsWith('/ta-track/'))) $('origin').value = url.origin;
      }
    }
    $('email').value = pairing?.email || $('email').value;
    $('email').disabled = tracking;
    $('origin').disabled = tracking;
    $('consent').checked = state.consent;
    $('start').disabled = tracking;
    $('pause').disabled = !tracking;
    $('destination').textContent = `Reports go to: ${$('origin').value}`;
    $('sync').textContent = pairing?.error || (pairing?.lastSyncAt ? `Last upload: ${new Date(pairing.lastSyncAt).toLocaleTimeString()}` : 'No activity uploaded yet.');
  } catch (error) { $('error').textContent = error.message; $('start').disabled = false; }
}
$('start').onclick = async () => {
  $('start').disabled = true;
  await send({ type: 'sign-in', origin: $('origin').value, email: $('email').value, consent: $('consent').checked });
};
$('pause').onclick = () => send({ type: 'pause' });
$('origin').oninput = () => { $('destination').textContent = `Reports go to: ${$('origin').value}`; };
send({ type: 'status' });
