/**
 * Career141 — capture the profile the TA is looking at.
 *
 * The rules this file exists to keep:
 *   - it reads only the page already on screen, in the TA's own session;
 *   - it reads only when the TA presses the button;
 *   - it never navigates, never queues, never walks a list of profiles.
 *
 * Everything below is a reader. There is no writer, no fetch to LinkedIn, and
 * no timer that captures on its own.
 */

(() => {
  "use strict";

  // ── reading the page ──────────────────────────────────────────────────────

  const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : null) || null;
  const txt = (el) => (el ? clean(el.textContent) : null);

  /**
   * LinkedIn ships a schema.org Person on the profile page. It survives their
   * class-name churn, which hand-picked selectors do not, so it is tried first
   * and the DOM is only a fallback.
   */
  function jsonLdPerson() {
    for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(tag.textContent);
      } catch {
        continue;
      }
      const nodes = data?.["@graph"] ?? (Array.isArray(data) ? data : [data]);
      for (const n of nodes || []) {
        const type = n?.["@type"];
        const isPerson = type === "Person" || (Array.isArray(type) && type.includes("Person"));
        if (isPerson && n.name) return n;
      }
    }
    return null;
  }

  /** Each list entry repeats itself for screen readers; the aria-hidden copy is
   *  the visible one, so reading those avoids every value arriving twice. */
  function visibleSpans(root) {
    return [...root.querySelectorAll('span[aria-hidden="true"]')]
      .map(txt)
      .filter(Boolean);
  }

  function sectionFor(anchorId) {
    const anchor = document.getElementById(anchorId);
    if (!anchor) return null;
    return anchor.closest("section") || anchor.parentElement;
  }

  function entriesIn(anchorId) {
    const section = sectionFor(anchorId);
    if (!section) return [];
    const items = section.querySelectorAll("ul > li");
    return [...items]
      .map((li) => visibleSpans(li))
      .filter((spans) => spans.length);
  }

  function readExperience() {
    return entriesIn("experience")
      .map(([title, company, dates]) => ({
        title: title || "",
        // "Career141 · Full-time" — the employment type is not the employer.
        company: clean((company || "").split("·")[0]) || "",
        dates: dates || null,
      }))
      .filter((e) => e.title || e.company)
      .slice(0, 25);
  }

  function readEducation() {
    return entriesIn("education")
      .map(([school, detail]) => ({ school: school || "", detail: detail || null }))
      .filter((e) => e.school)
      .slice(0, 15);
  }

  function readSkills() {
    return entriesIn("skills")
      .map(([skill]) => skill)
      .filter(Boolean)
      .slice(0, 60);
  }

  /** Only present when the TA has the contact-info panel open. Nothing here
   *  opens it — an extension that clicks through a profile is automation. */
  function readContact() {
    const modal = document.querySelector(".pv-contact-info, [data-test-modal] .pv-profile-section");
    const scope = modal || document;
    const mail = scope.querySelector('a[href^="mailto:"]');
    const phone = [...scope.querySelectorAll("span, li")]
      .map(txt)
      .find((t) => t && /^\+?[\d][\d\s()+-]{7,}$/.test(t));
    return {
      email: mail ? clean(mail.getAttribute("href").replace(/^mailto:/, "")) : null,
      phone: phone || null,
    };
  }

  function topCard() {
    return document.querySelector("main section") || document.querySelector("main");
  }

  function extractProfile() {
    const ld = jsonLdPerson();
    const card = topCard();
    const cardText = card ? card.innerText || "" : "";

    const fullName =
      (ld && clean(ld.name)) || txt(document.querySelector("main h1")) || null;

    const headline =
      (ld && clean(ld.description)) ||
      txt(document.querySelector("main .text-body-medium")) ||
      null;

    const location =
      (ld &&
        clean(
          [ld.address?.addressLocality, ld.address?.addressRegion, ld.address?.addressCountry]
            .filter(Boolean)
            .join(", "),
        )) ||
      txt(document.querySelector("main .text-body-small.inline")) ||
      null;

    const experience = readExperience();

    const worksFor = ld?.worksFor?.[0]?.name ? clean(ld.worksFor[0].name) : null;
    const jobTitle = Array.isArray(ld?.jobTitle) ? clean(ld.jobTitle[0]) : clean(ld?.jobTitle);

    const about =
      txt(sectionFor("about")?.querySelector('span[aria-hidden="true"]')) || null;

    const degreeMatch = cardText.match(/\b(1st|2nd|3rd)\b/);
    const contact = readContact();

    return {
      fullName,
      headline,
      currentTitle: jobTitle || experience[0]?.title || null,
      currentCompany: worksFor || experience[0]?.company || null,
      location,
      about,
      connectionDegree: degreeMatch ? degreeMatch[1] : null,
      openToWork: /#?open\s*to\s*work/i.test(cardText),
      experience,
      education: readEducation(),
      skills: readSkills(),
      email: contact.email,
      phone: contact.phone,
      sourceUrl: location_href(),
    };
  }

  /** Without the tracking query, which is not part of who someone is. */
  function location_href() {
    const u = new URL(window.location.href);
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  // ── the button ────────────────────────────────────────────────────────────

  let host = null;
  let root = null;
  let busy = false;

  function build() {
    if (host && document.body.contains(host)) return;
    host = document.createElement("div");
    host.id = "c141-capture-host";
    // A shadow root so LinkedIn's stylesheet cannot reach in and this cannot
    // reach out — an injected button that inherits page CSS breaks on their
    // next deploy.
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .bar {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
          display: flex; align-items: center; gap: 10px;
          padding: 10px 14px; border-radius: 999px;
          background: #165b42; color: #fff;
          font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          box-shadow: 0 6px 24px rgba(0,0,0,.22); cursor: pointer;
          border: 0; transition: opacity .15s, transform .15s;
        }
        .bar:hover { transform: translateY(-1px); }
        .bar[disabled] { opacity: .65; cursor: default; transform: none; }
        .bar.ok { background: #14663f; }
        .bar.bad { background: #b3261e; }
        .to { opacity: .72; font-weight: 400; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: .8; }
      </style>
      <button class="bar" type="button">
        <span class="dot"></span>
        <span class="label">Add to Career141</span>
        <span class="to"></span>
      </button>`;
    document.documentElement.appendChild(host);
    root.querySelector("button").addEventListener("click", capture);
    paintTarget();
  }

  function setState(text, tone) {
    if (!root) return;
    const bar = root.querySelector(".bar");
    bar.classList.remove("ok", "bad");
    if (tone) bar.classList.add(tone);
    root.querySelector(".label").textContent = text;
  }

  async function paintTarget() {
    const { openingLabel } = await chrome.storage.sync.get("openingLabel");
    if (root) root.querySelector(".to").textContent = openingLabel ? `→ ${openingLabel}` : "";
  }

  async function capture() {
    if (busy) return;
    busy = true;
    const bar = root.querySelector(".bar");
    bar.disabled = true;
    setState("Reading the page…");

    try {
      const profile = extractProfile();
      if (!profile.fullName) throw new Error("Could not read a name off this page");

      const res = await chrome.runtime.sendMessage({ type: "capture", profile });
      if (!res?.ok) throw new Error(res?.error || "The platform refused it");

      setState(res.status === "updated" ? "Updated in the table" : "Added to the table", "ok");
    } catch (err) {
      setState(err.message.slice(0, 60), "bad");
    } finally {
      setTimeout(() => {
        busy = false;
        bar.disabled = false;
        setState("Add to Career141");
        paintTarget();
      }, 2600);
    }
  }

  // LinkedIn is a single-page app, so the button has to survive a navigation
  // that never reloads the document.
  let seen = location.href;
  setInterval(() => {
    if (location.href !== seen) {
      seen = location.href;
      build();
    }
  }, 800);

  chrome.storage.onChanged.addListener(paintTarget);

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === "read-profile") {
      respond({ ok: true, profile: extractProfile() });
    }
    return true;
  });

  build();
})();
