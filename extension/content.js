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

  // Do not run inside iframes (e.g. LinkedIn messaging frame or widgets)
  if (window !== window.top) return;

  // ── reading the page ──────────────────────────────────────────────────────

  const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : null) || null;
  const txt = (el) => (el ? clean(el.textContent) : null);

  function cleanName(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.replace(/\s+/g, " ").trim();
    // Remove pronouns e.g. (He/Him), (She/Her), (They/Them)
    s = s.replace(/\s*\((?:he\/him|she\/her|they\/them|he\/they|she\/they|[a-z/]+)\)/gi, "");
    // Remove connection degree like "· 1st", "· 2nd", "· 3rd", "· 1st degree connection"
    s = s.replace(/\s*[·•\-]\s*(?:1st|2nd|3rd|\d+(?:st|nd|rd|th))\s*(?:degree)?(?:\s*connection)?/gi, "");
    // Remove trailing badge keywords
    s = s.replace(/\s*(?:verified|open to work|premium|hiring)\s*$/gi, "");
    // Remove leading/trailing bullets and dashes
    s = s.replace(/^[·•\-\s,]+|[·•\-\s,]+$/g, "").trim();
    return s.length >= 2 ? s : null;
  }

  /**
   * LinkedIn ships a schema.org Person on the profile page in some views. It
   * survives class-name churn, so it is tried first.
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
    if (anchor) return anchor.closest("section") || anchor.parentElement;

    // Check data-section attribute
    const dataSec = document.querySelector(`section[data-section="${anchorId}"]`);
    if (dataSec) return dataSec;

    // Search by h2 text header
    for (const sec of document.querySelectorAll("section")) {
      const h2 = sec.querySelector("h2");
      if (h2 && new RegExp(`^\\s*${anchorId}\\s*$`, "i").test(h2.textContent || "")) {
        return sec;
      }
    }
    return null;
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
    const modal = document.querySelector(".pv-contact-info, [data-test-modal] .pv-profile-section, .artdeco-modal");
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
    return document.querySelector(".pv-top-card, main section, .scaffold-layout__main section, main");
  }

  /**
   * Recruiter (`/talent/…`) renders candidates through Ember entity lockup
   * components.
   */
  function recruiterField(selector) {
    return txt(document.querySelector(selector));
  }

  function recruiterLockup() {
    // In order of trust, not page order (1 Oct): the open profile's own header
    // first. A list row or a sidebar card ("People also viewed") is someone
    // else, and reading their name put profiles on the wrong person.
    const nameEl = [
      "[data-test-profile-header-name]",
      "[data-test-row-lockup-full-name] a[data-test-lockup-name-button]",
      "a[data-test-lockup-name-button]",
    ]
      .map((s) => document.querySelector(s))
      .find(Boolean);
    if (!nameEl) return null;
    const degreeText = recruiterField("[data-test-lockup-degree] .artdeco-entity-lockup__degree");
    const degreeMatch = degreeText && degreeText.match(/\b(1st|2nd|3rd)\b/);
    return {
      fullName: cleanName(txt(nameEl)),
      headline: recruiterField("[data-test-row-lockup-headline]"),
      location: recruiterField("[data-test-row-lockup-location]"),
      connectionDegree: degreeMatch ? degreeMatch[1] : null,
    };
  }

  function readFullName(ld, recruiter) {
    // 1. JSON-LD Person
    if (ld?.name) {
      const n = cleanName(clean(ld.name));
      if (n) return n;
    }

    // 2. Recruiter lockup — on Recruiter pages only. On a public profile the
    // page's own h1 is the person; a lockup there is a sidebar card (1 Oct).
    if (recruiter?.fullName && window.location.pathname.startsWith("/talent/")) {
      const n = cleanName(recruiter.fullName);
      if (n) return n;
    }

    // 3. Known LinkedIn DOM selectors for profile name
    const selectors = [
      "main h1",
      ".pv-top-card h1",
      ".pv-top-card--list h1",
      "h1.text-heading-xlarge",
      "h1.v-align-middle",
      "h1.inline.t-24",
      "section.artdeco-card h1",
      ".scaffold-layout__main h1",
      '[data-test-row-lockup-full-name] a[data-test-lockup-name-button]',
      'a[data-test-lockup-name-button]',
      '[data-test-profile-header-name]',
      '[data-anonymize="person-name"]',
      '.artdeco-entity-lockup__title',
      '.topcard-condensed__title',
      '.profile-topcard__lead-name',
      '.profile-topcard-person-entity__name',
      "main section:first-of-type h1",
      "h1",
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        // If element has aria-hidden span inside, prefer that (avoids screen-reader duplicate text)
        const ariaSpan = el.querySelector('span[aria-hidden="true"]');
        const text = txt(ariaSpan) || txt(el);
        const name = cleanName(text);
        if (name && !/^(linkedin|feed|notifications|jobs|messaging|my network|search|sign in|join linkedin)$/i.test(name)) {
          return name;
        }
      }
    }

    // 4. OpenGraph / Twitter meta tags
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    if (ogTitle) {
      const part = ogTitle.split(/[|\-–—•·]/)[0];
      const name = cleanName(clean(part));
      if (name && !/^(linkedin|sign in|join linkedin)$/i.test(name)) return name;
    }

    // 5. Document title fallback: "(1) First Last | LinkedIn" -> "First Last"
    if (document.title) {
      const titleCleaned = document.title.replace(/^\(\d+\)\s*/, "");
      const part = titleCleaned.split(/[|\-–—•·]/)[0];
      const name = cleanName(clean(part));
      if (name && !/^(linkedin|feed|notifications|jobs|messaging|my network|search|sign in|join linkedin)$/i.test(name)) {
        return name;
      }
    }

    // 6. URL slug fallback: https://www.linkedin.com/in/gajani-uruthirananthan-12345/ -> Gajani Uruthirananthan
    const slugMatch = window.location.pathname.match(/\/in\/([^/]+)/);
    if (slugMatch && slugMatch[1]) {
      const slugName = decodeURIComponent(slugMatch[1])
        .replace(/-[a-f0-9]{6,12}$/i, "")
        .replace(/[-_.]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      if (slugName.length >= 2) return slugName;
    }

    return null;
  }

  function readHeadline(ld, recruiter) {
    if (ld?.description) return clean(ld.description);
    if (recruiter?.headline) return recruiter.headline;
    const selectors = [
      "main .text-body-medium",
      ".pv-top-card .text-body-medium",
      "div.text-body-medium",
      '[data-test-row-lockup-headline]',
      '[data-anonymize="headline"]',
      ".topcard-condensed__headline",
      ".profile-topcard__summary-position",
    ];
    for (const sel of selectors) {
      const val = txt(document.querySelector(sel));
      if (val) return val;
    }
    return null;
  }

  function readLocation(ld, recruiter) {
    if (ld?.address) {
      const loc = clean(
        [ld.address?.addressLocality, ld.address?.addressRegion, ld.address?.addressCountry]
          .filter(Boolean)
          .join(", ")
      );
      if (loc) return loc;
    }
    if (recruiter?.location) return recruiter.location;
    const selectors = [
      "main .text-body-small.inline",
      ".pv-top-card .text-body-small.inline",
      "span.text-body-small.inline",
      '[data-test-row-lockup-location]',
      '[data-anonymize="location"]',
      ".topcard-condensed__location",
      ".profile-topcard__location-data",
    ];
    for (const sel of selectors) {
      const val = txt(document.querySelector(sel));
      if (val) return val;
    }
    return null;
  }

  /** Recruiter's headline is one string, "Title at Company" */
  function splitHeadline(headline) {
    const m = headline && headline.match(/^(.*?)\s+at\s+(.+)$/i);
    return m ? { title: clean(m[1]), company: clean(m[2]) } : { title: clean(headline), company: null };
  }

  function extractProfile() {
    const ld = jsonLdPerson();
    const recruiter = recruiterLockup();
    const card = topCard();
    const cardText = card ? card.innerText || "" : "";

    const fullName = readFullName(ld, recruiter);
    const headline = readHeadline(ld, recruiter);
    const location = readLocation(ld, recruiter);

    const experience = readExperience();

    const worksFor = ld?.worksFor?.[0]?.name ? clean(ld.worksFor[0].name) : null;
    const jobTitle = Array.isArray(ld?.jobTitle) ? clean(ld.jobTitle[0]) : clean(ld?.jobTitle);
    const recruiterTitleCompany =
      !worksFor && !jobTitle && recruiter?.headline ? splitHeadline(recruiter.headline) : null;

    const about =
      txt(sectionFor("about")?.querySelector('span[aria-hidden="true"]')) ||
      txt(sectionFor("about")) ||
      null;

    const degreeMatch = cardText.match(/\b(1st|2nd|3rd)\b/);
    const contact = readContact();

    return {
      fullName,
      headline,
      currentTitle: jobTitle || recruiterTitleCompany?.title || experience[0]?.title || null,
      currentCompany: worksFor || recruiterTitleCompany?.company || experience[0]?.company || null,
      location,
      about,
      connectionDegree: (degreeMatch ? degreeMatch[1] : null) || recruiter?.connectionDegree || null,
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
  let savedPos = null;

  try {
    const raw = localStorage.getItem("c141_btn_pos");
    if (raw) savedPos = JSON.parse(raw);
  } catch {}

  function applySavedPosition(bar) {
    if (!bar) return;
    if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
      const rect = bar.getBoundingClientRect();
      const w = rect.width || 240;
      const h = rect.height || 40;
      const maxLeft = Math.max(10, window.innerWidth - w - 10);
      const maxTop = Math.max(10, window.innerHeight - h - 10);
      const left = Math.min(Math.max(10, savedPos.left), maxLeft);
      const top = Math.min(Math.max(10, savedPos.top), maxTop);
      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
      bar.style.right = "auto";
      bar.style.bottom = "auto";
    }
  }

  function makeDraggable(bar) {
    let isDragging = false;
    const dragThreshold = 5;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let hasMoved = false;

    applySavedPosition(bar);
    requestAnimationFrame(() => applySavedPosition(bar));
    setTimeout(() => applySavedPosition(bar), 120);

    bar.addEventListener("pointerdown", (e) => {
      // Only drag with primary mouse button / touch
      if (e.button !== 0) return;
      const rect = bar.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      hasMoved = false;
      isDragging = false;

      try {
        bar.setPointerCapture(e.pointerId);
      } catch {}

      const onPointerMove = (moveEv) => {
        const dx = moveEv.clientX - startX;
        const dy = moveEv.clientY - startY;

        if (!hasMoved && Math.hypot(dx, dy) > dragThreshold) {
          hasMoved = true;
          isDragging = true;
          bar.classList.add("dragging");
        }

        if (isDragging) {
          const bRect = bar.getBoundingClientRect();
          const maxLeft = Math.max(10, window.innerWidth - bRect.width - 10);
          const maxTop = Math.max(10, window.innerHeight - bRect.height - 10);
          const newLeft = Math.min(Math.max(10, initialLeft + dx), maxLeft);
          const newTop = Math.min(Math.max(10, initialTop + dy), maxTop);

          bar.style.left = `${newLeft}px`;
          bar.style.top = `${newTop}px`;
          bar.style.right = "auto";
          bar.style.bottom = "auto";
        }
      };

      const onPointerUp = (upEv) => {
        bar.removeEventListener("pointermove", onPointerMove);
        bar.removeEventListener("pointerup", onPointerUp);
        bar.removeEventListener("pointercancel", onPointerUp);
        try {
          bar.releasePointerCapture(upEv.pointerId);
        } catch {}

        if (isDragging) {
          bar.classList.remove("dragging");
          const bRect = bar.getBoundingClientRect();
          savedPos = { left: bRect.left, top: bRect.top };
          try {
            localStorage.setItem("c141_btn_pos", JSON.stringify(savedPos));
          } catch {}

          // Suppress click event after dragging
          const cancelClick = (clickEv) => {
            clickEv.stopPropagation();
            clickEv.preventDefault();
            bar.removeEventListener("click", cancelClick, true);
          };
          bar.addEventListener("click", cancelClick, true);
          setTimeout(() => {
            bar.removeEventListener("click", cancelClick, true);
          }, 80);
        }
      };

      bar.addEventListener("pointermove", onPointerMove);
      bar.addEventListener("pointerup", onPointerUp);
      bar.addEventListener("pointercancel", onPointerUp);
    });
  }

  window.addEventListener("resize", () => {
    if (root) {
      const bar = root.querySelector(".bar");
      if (bar) applySavedPosition(bar);
    }
  });

  function build() {
    if (window !== window.top) return;
    if (!chrome.runtime?.id) {
      for (const el of document.querySelectorAll("#c141-capture-host")) {
        el.remove();
      }
      return;
    }

    // Always remove any stale host elements from previous script runs or navigation
    for (const el of document.querySelectorAll("#c141-capture-host")) {
      el.remove();
    }

    host = document.createElement("div");
    host.id = "c141-capture-host";
    // A shadow root so LinkedIn's stylesheet cannot reach in and this cannot
    // reach out — an injected button that inherits page CSS breaks on their
    // next deploy.
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .bar {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
          display: flex; align-items: center; gap: 8px;
          padding: 10px 16px 10px 12px; border-radius: 999px;
          background: #165b42; color: #ffffff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px; font-weight: 500; line-height: 1.2;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          text-rendering: optimizeLegibility;
          box-shadow: 0 6px 24px rgba(0,0,0,.28); cursor: grab;
          border: 0;
          user-select: none;
          white-space: nowrap;
          backface-visibility: hidden;
          touch-action: none;
          transition: opacity .15s ease, background-color .15s ease, box-shadow .15s ease;
        }
        .bar:hover { box-shadow: 0 8px 28px rgba(0,0,0,.36); }
        .bar.dragging { cursor: grabbing; transition: none; opacity: .94; box-shadow: 0 12px 32px rgba(0,0,0,.45); }
        .bar[disabled] { opacity: .75; cursor: default; }
        .bar.ok { background: #14663f; }
        .bar.bad { background: #b3261e; }
        .drag-icon {
          display: inline-flex; align-items: center; justify-content: center;
          opacity: .6; font-size: 11px; margin-right: 2px; cursor: grab;
        }
        .bar.dragging .drag-icon { cursor: grabbing; }
        .to { opacity: .75; font-weight: 400; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #ffffff; opacity: .85; flex-shrink: 0; }
      </style>
      <button class="bar" type="button" title="Click to shortlist · Drag to move anywhere">
        <span class="drag-icon" title="Drag to move">⋮⋮</span>
        <span class="dot"></span>
        <span class="label">Add to Career141</span>
        <span class="to"></span>
      </button>`;
    (document.body || document.documentElement).appendChild(host);
    const btn = root.querySelector("button");
    btn.addEventListener("click", capture);
    makeDraggable(btn);
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
    try {
      if (!chrome.runtime?.id) return;
      const data = await chrome.storage.sync.get("openingLabel").catch(() => null);
      if (root && data) root.querySelector(".to").textContent = data.openingLabel ? `→ ${data.openingLabel}` : "";
    } catch {
      // Ignore if context invalidated or storage unavailable
    }
  }

  async function capture() {
    if (busy) return;
    if (!chrome.runtime?.id) {
      setState("Extension reloaded — refresh (F5)", "bad");
      return;
    }
    busy = true;
    const bar = root.querySelector(".bar");
    bar.disabled = true;
    setState("Reading the page…");

    try {
      const profile = extractProfile();
      if (!profile.fullName) throw new Error("Could not read a name off this page");

      let res;
      try {
        if (!chrome.runtime?.id) throw new Error("Extension reloaded — please refresh page (F5)");
        res = await chrome.runtime.sendMessage({ type: "capture", profile });
      } catch (runtimeErr) {
        if (/context invalidated/i.test(runtimeErr?.message || "")) {
          throw new Error("Extension reloaded — please refresh page (F5)");
        }
        throw runtimeErr;
      }
      if (!res?.ok) throw new Error(res?.error || "The platform refused it");

      setState(
        res.status === "updated"
          ? `Already in the table${res.addedByName ? ` — added by ${res.addedByName}` : ""}. Updated, not added again`
          : "Shortlisted in the table",
        "ok",
      );
    } catch (err) {
      const msg = /context invalidated/i.test(err?.message || "")
        ? "Extension reloaded — refresh (F5)"
        : err.message.slice(0, 60);
      setState(msg, "bad");
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
  const navTimer = setInterval(() => {
    if (!chrome.runtime?.id) {
      clearInterval(navTimer);
      for (const el of document.querySelectorAll("#c141-capture-host")) {
        el.remove();
      }
      return;
    }
    if (location.href !== seen) {
      seen = location.href;
      build();
    }
  }, 800);

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(() => {
      if (chrome.runtime?.id) paintTarget();
    });
  }

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (msg?.type === "read-profile") {
        respond({ ok: true, profile: extractProfile() });
      }
      return true;
    });
  }

  build();
})();
