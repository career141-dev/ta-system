/**
 * The only thing that talks to the platform.
 *
 * It lives here rather than in the content script because a fetch made from a
 * LinkedIn page is subject to LinkedIn's own content-security policy, and a
 * capture that silently fails on their next policy change is worse than one
 * that never worked.
 */

const DEFAULTS = { platformUrl: "http://localhost:3100" };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
}

async function post(path, body) {
  const { platformUrl, token } = await settings();
  if (!token) throw new Error("No access token — open the extension and paste one");

  const res = await fetch(`${platformUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-C141-Token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Platform said ${res.status}`);
  return data;
}

async function get(path) {
  const { platformUrl, token } = await settings();
  if (!token) throw new Error("No access token");
  const res = await fetch(`${platformUrl.replace(/\/$/, "")}${path}`, {
    headers: { "X-C141-Token": token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Platform said ${res.status}`);
  return data;
}

async function capture(profile) {
  const { openingId, userId } = await settings();
  if (!openingId) throw new Error("Pick an opening in the extension first");
  if (!userId) throw new Error("Pick who you are in the extension first");

  const result = await post("/api/extension/capture", { openingId, userId, profile });

  // A short local history, so the TA can see what went where without leaving
  // the page. Names only — the full capture lives in the platform.
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift({
    name: result.name,
    status: result.status,
    opening: result.openingTitle,
    url: profile.sourceUrl,
    at: Date.now(),
  });
  await chrome.storage.local.set({ history: history.slice(0, 25) });

  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const run = async () => {
    if (msg?.type === "capture") return { ok: true, ...(await capture(msg.profile)) };
    if (msg?.type === "openings") return { ok: true, ...(await get("/api/extension/openings")) };
    throw new Error("unknown message");
  };
  run()
    .then(respond)
    .catch((e) => respond({ ok: false, error: e.message }));
  return true;
});
