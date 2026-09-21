"use strict";

const $ = (id) => document.getElementById(id);
const say = (text, tone) => {
  $("status").textContent = text;
  $("status").className = `status ${tone || ""}`;
};

const send = (msg) =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

async function load() {
  const s = await chrome.storage.sync.get(null);
  $("platformUrl").value = s.platformUrl || "http://localhost:3100";
  $("token").value = s.token || "";

  // No token yet means nothing else on this panel can work, so open on the
  // thing the TA has to do first.
  if (!s.token) {
    $("settings").hidden = false;
    $("main").hidden = true;
    return;
  }

  const res = await send({ type: "openings" });
  if (!res?.ok) {
    $("settings").hidden = false;
    say(res?.error || "Could not reach the platform", "bad");
    return;
  }

  fill($("userId"), res.users.map((u) => [u.id, u.name]), s.userId);
  fill(
    $("openingId"),
    res.openings.map((o) => [o.id, `${o.client} — ${o.title}`]),
    s.openingId,
  );
  paintHistory();
}

function fill(select, pairs, chosen) {
  select.innerHTML = "";
  for (const [value, label] of pairs) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === chosen) opt.selected = true;
    select.appendChild(opt);
  }
  remember();
}

/** The label is stored too, so the button on the LinkedIn page can name the
 *  opening without asking the platform on every page load. */
async function remember() {
  const openingSelect = $("openingId");
  await chrome.storage.sync.set({
    userId: $("userId").value,
    openingId: openingSelect.value,
    openingLabel: openingSelect.selectedOptions[0]?.textContent ?? "",
  });
}

async function paintHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  $("history").innerHTML = "";
  if (!history.length) {
    $("history").innerHTML = '<li style="color:#8b9298">Nothing captured yet.</li>';
    return;
  }
  for (const h of history.slice(0, 8)) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = h.name || "Unnamed";
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = h.opening;
    li.append(who, where);
    $("history").appendChild(li);
  }
}

$("settings-toggle").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});

$("connect").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    platformUrl: $("platformUrl").value.trim(),
    token: $("token").value.trim(),
  });
  $("main").hidden = false;
  say("");
  load();
});

$("userId").addEventListener("change", remember);
$("openingId").addEventListener("change", remember);

$("capture").addEventListener("click", async () => {
  $("capture").disabled = true;
  say("Reading the page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/^https:\/\/[a-z]{2,3}\.linkedin\.com\//i.test(tab?.url || "")) {
      throw new Error("Open a LinkedIn profile first");
    }
    const read = await chrome.tabs.sendMessage(tab.id, { type: "read-profile" });
    if (!read?.ok) throw new Error("Could not read that page");

    const res = await send({ type: "capture", profile: read.profile });
    if (!res?.ok) throw new Error(res?.error || "The platform refused it");

    say(res.status === "updated" ? `${res.name} updated in ${res.openingTitle}` : `${res.name} shortlisted in ${res.openingTitle}`, "ok");
    paintHistory();
  } catch (e) {
    say(e.message, "bad");
  } finally {
    $("capture").disabled = false;
  }
});

load();
