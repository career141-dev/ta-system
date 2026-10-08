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

  const JUNK_COMPANY_REGEX =
    /^(brave|chrome|firefox|safari|edge|opera|browser|linkedin|experience|education|contact\s*info|connections|message|more|connect|follow|pending|shortlisted|1st|2nd|3rd|\d+(?:st|nd|rd|th)|mutual\s*connection|about|skills|activity|interests|recommendations|volunteer|licenses\s*&\s*certifications|honors\s*&\s*awards|languages|organizations|publications|patents|courses|projects|test\s*scores)$/i;

  function cleanCompany(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.replace(/\s+/g, " ").trim();
    // Remove "View company: ", "Current company: ", "Company: ", "Employer: ", "View employer: ", "See company: " prefixes
    s = s.replace(/^(?:view|current|see|visit)?\s*(?:company|employer|organization|page(?:\s+for)?):\s*/i, "");
    s = s.replace(/^(?:view|see|visit)\s+/i, "");
    // Remove trailing "'s company page", " company page", " company profile"
    s = s.replace(/(?:'s|’s)?\s*(?:company|organization)?\s*(?:page|profile)\s*$/i, "");
    // Remove trailing "· Full-time", "· Part-time", "· Contract", "· Self-employed", "· Internship", "· Freelance", "· Seasonal"
    s = s.replace(
      /\s*[·•\-]\s*(?:full[-\s]time|part[-\s]time|contract|self[-\s]employed|freelance|internship|seasonal|apprenticeship|permanent).*$/i,
      ""
    );
    // Remove trailing "... Click to skip to experience section." or "Click to..."
    s = s.replace(/\.?\s*click to skip to .*$/i, "");
    s = s.replace(/\.?\s*click to .*$/i, "");
    // Remove trailing " logo" e.g. "DirectFN Sri Lanka logo" -> "DirectFN Sri Lanka"
    s = s.replace(/\s+logo\s*$/i, "");
    // Remove leading/trailing bullets, dashes, commas, colons
    s = s.replace(/^[·•\-\s,:]+|[·•\-\s,:]+$/g, "").trim();
    if (s.length < 2 || JUNK_COMPANY_REGEX.test(s)) return null;
    return s;
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
    const isDuration = (t) => /^\d+\s*(yrs?|mos?|years?|months?)\b/i.test(t || "");
    return entriesIn("experience")
      .map(([a, b, c]) => {
        const grouped = isDuration(b); // [Company, "3 yrs 2 mos", …]
        return {
          title: grouped ? "" : a || "",
          company: cleanCompany(((grouped ? a : b) || "").split("·")[0]) || "",
          dates: (grouped ? b : c) || null,
        };
      })
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
   *  opens it — an extension that clicks through a profile is automation, and
   *  can get a LinkedIn account restricted.
   *
   *  Read from that panel only (1 Oct). It used to search the whole page when
   *  the panel was shut, so any number on the page — a colleague's in a post, a
   *  company's — became this person's phone, and matched them to someone else. */
  function contactPanel() {
    const direct = document.querySelector(".pv-contact-info, [data-test-contact-info-section]");
    if (direct) return direct;
    // The panel is a dialog headed "Contact info"; any other dialog is not it.
    return [...document.querySelectorAll('.artdeco-modal, [role="dialog"]')].find((d) => /contact info/i.test(txt(d.querySelector("h1, h2, h3")) || "")) || null;
  }

  function readContact() {
    const scope = contactPanel();
    if (!scope) return { email: null, phone: null, open: false };
    const mail = scope.querySelector('a[href^="mailto:"]');
    const phone = [...scope.querySelectorAll("span, li")]
      .map(txt)
      .find((t) => t && /^\+?[\d][\d\s()+-]{7,}$/.test(t));
    return {
      email: mail ? clean(mail.getAttribute("href").replace(/^mailto:/, "")) : null,
      phone: phone || null,
      open: true,
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
    // The open profile's id is in the address (…/profile/<id>). A name link
    // pointing at that id is that person, wherever it sits on the page; the
    // first lockup on a list is just whoever is first (5 Oct).
    const id = (window.location.pathname.match(/\/profile\/([A-Za-z0-9_-]{10,})/) || [])[1];
    const byId = id ? document.querySelector(`a[data-test-lockup-name-button][href*="${CSS.escape(id)}"]`) : null;
    const nameEl = byId || [
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

  /**
   * Parses headlines like:
   * - "Full-Stack Engineer | React, Spring Boot, NestJS | Cloud (AWS)..." -> title: "Full-Stack Engineer"
   * - "Senior Software Engineer at Google" -> title: "Senior Software Engineer", company: "Google"
   * - "Lead Developer @ Stripe" -> title: "Lead Developer", company: "Stripe"
   */
  function splitHeadline(headline) {
    if (!headline || typeof headline !== "string") return { title: null, company: null };
    const h = headline.trim();
    const atMatch = h.match(/^(.*?)\s+(?:at|@)\s+([^|•·\n]+)/i);
    if (atMatch) {
      const title = clean(atMatch[1]);
      const company = cleanCompany(atMatch[2]);
      if (title) return { title, company };
    }
    const parts = h.split(/\s+[|•·–—]\s+/).map(clean).filter(Boolean);
    if (parts.length > 0) {
      const firstPart = parts[0];
      const firstAt = firstPart.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (firstAt) {
        return { title: clean(firstAt[1]), company: cleanCompany(firstAt[2]) };
      }
      return { title: firstPart, company: null };
    }
    return { title: clean(h), company: null };
  }

  const abs = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, left: r.left + window.scrollX, h: r.height, w: r.width };
  };

  /** The profile's own name: the largest visible text starting with the name.
   *  LinkedIn also keeps a small sticky copy of it in a mini header. */
  function nameElement(fullName) {
    if (!fullName) return null;
    const cands = [...document.querySelectorAll("h1, h2, p")].filter((e) => {
      const t = txt(e);
      return (
        t &&
        t.startsWith(fullName) &&
        t.length <= fullName.length + 14 &&
        e.getBoundingClientRect().height > 0
      );
    });
    const size = (e) => parseFloat(getComputedStyle(e).fontSize) || 0;
    cands.sort((a, b) => size(b) - size(a) || abs(a).top - abs(b).top);
    return cands[0] || null;
  }

  function topCardBox(fullName) {
    const nameEl = nameElement(fullName);
    if (!nameEl) return null;
    let box = nameEl.closest("section");
    if (!box) {
      box = nameEl.parentElement;
      for (let i = 0; i < 6 && box?.parentElement; i++) box = box.parentElement;
    }
    return box ? { nameEl, box } : null;
  }

  const SCHOOL_RE = /universit|college|school|institute|campus|academy|polytechnic|faculty/i;
  let panelDbg = "";

  /** Current employer from the top card, by position. Wide layout: a panel to the
   *  right of the name, one row per logo + text (company first, school second).
   *  Narrow layout: one line "Company · School". Schools are skipped, so a school
   *  is never filed as an employer. */
  function topCardCompany(fullName, headline) {
    const nameEl = nameElement(fullName);
    if (!nameEl) {
      panelDbg = "panel: name not found";
      return null;
    }
    const n = abs(nameEl);

    let rows = [];
    for (const img of document.querySelectorAll("img")) {
      const b = abs(img);
      if (b.w < 16 || b.w > 90) continue; // logos, not the profile photo
      if (b.top < n.top - 30 || b.top > n.top + 220 || b.left < n.left + 250) continue;
      let el = img.parentElement,
        t = null;
      for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
        const x = txt(el);
        if (x && x.length < 90) {
          t = x;
          break;
        }
      }
      if (t && !/mutual|connection|follower/i.test(t)) rows.push({ t, top: b.top });
    }
    rows.sort((a, b) => a.top - b.top);
    rows = rows.filter((r, i) => !rows.some((o, j) => j !== i && o.t !== r.t && r.t.includes(o.t)));

    let company = null;
    for (const r of rows) {
      if (SCHOOL_RE.test(r.t)) continue;
      company = cleanCompany(r.t);
      if (company) break;
    }

    let line = null;
    if (!company && rows.length === 0) {
      for (const p of document.querySelectorAll("p")) {
        if (p.querySelector("p")) continue;
        const b = abs(p);
        const t = txt(p);
        if (!t || b.h === 0 || b.top < n.top + 10 || b.top > n.top + 260 || b.left < n.left - 5) continue;
        if (!/\s[·•]\s/.test(t) || /contact info|mutual|follower|connection/i.test(t)) continue;
        if (headline && (t === headline || headline.includes(t))) continue;
        line = t;
        const first = t.split(/\s+[·•]\s+/)[0];
        if (SCHOOL_RE.test(first) || /,/.test(first)) continue;
        company = cleanCompany(first);
        if (company) break;
      }
    }

    panelDbg = `panel: ${rows.map((r) => r.t.slice(0, 20)).join(" / ") || (line ? "line: " + line.slice(0, 30) : "no rows")} → ${company || "none"}`;
    return company;
  }

  const EMPLOYMENT_TYPES =
    "full[-\\s]time|part[-\\s]time|contract|self[-\\s]employed|freelance|internship|apprenticeship|seasonal|permanent|temporary";
  const COMPANY_LINE = new RegExp(`^(.{2,80}?)\\s+[·•]\\s+(?:${EMPLOYMENT_TYPES})\\b`, "i");
  let companyDbg = "";

  /** Current employer from the Experience section. An entry reads
   *  "Company · Full-time" in a plain <p>, so match on that text, not on
   *  LinkedIn's hashed class names. Prefers the entry dated "Present". */
  function companyFromExperience() {
    const heading = [...document.querySelectorAll("h2, h3, p, span, div")].find(
      (e) => !e.children.length && /^experience$/i.test(txt(e) || "")
    );
    if (!heading) {
      companyDbg = "Experience heading: not on page yet (scroll down once)";
      return null;
    }
    const linesOf = (root) => [...root.querySelectorAll("p")].map((p) => ({ p, t: txt(p) })).filter((x) => x.t);
    const after = (root) =>
      linesOf(root).filter((x) => heading.compareDocumentPosition(x.p) & Node.DOCUMENT_POSITION_FOLLOWING);
    const has = (root) => after(root).some((x) => COMPANY_LINE.test(x.t));

    let box = heading.closest("section");
    if (!box || !has(box)) {
      box = heading.parentElement;
      for (let i = 0; i < 8 && box && !has(box); i++) box = box.parentElement;
    }
    if (!box) {
      companyDbg = "Experience heading found, but no 'Company · Full-time' lines";
      return null;
    }

    const all = after(box);
    const entries = [];
    all.forEach((x, i) => {
      const m = x.t.match(COMPANY_LINE);
      if (!m) return;
      const near = all.slice(i + 1, i + 5).map((y) => y.t).join(" | ");
      entries.push({ company: cleanCompany(m[1]), current: /\bpresent\b/i.test(near) });
    });
    const pick = entries.find((e) => e.current && e.company) || entries.find((e) => e.company);
    companyDbg = `Experience entries: ${entries.length} | picked: ${
      pick ? pick.company + (pick.current ? " (Present)" : " (latest)") : "none"
    }`;
    return pick ? pick.company : null;
  }

  /** Headline and location only. The company is not guessed from loose text or
   *  image alts: a mutual connection's avatar would become the employer. */
  function readTopCardLines(fullName) {
    const none = { headline: null, location: null };
    const ctx = topCardBox(fullName);
    if (!ctx) return none;
    const { nameEl, box } = ctx;
    const pLines = [...box.querySelectorAll("p")]
      .filter(
        (p) =>
          p !== nameEl &&
          !nameEl.contains(p) &&
          nameEl.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING
      )
      .map((p) => txt(p))
      .filter((t) => t && !/^[·•]?\s*(1st|2nd|3rd)\+?$/i.test(t) && !/^\(?(he|she|they)\b[^a-z]*$/i.test(t));
    const headline = pLines[0] || null;
    const locLine = pLines.find((l) => /contact info/i.test(l));
    const location = locLine ? locLine.replace(/\s*[·•]?\s*contact info\s*$/i, "").trim() : null;
    return { headline, location };
  }

  function extractProfile() {
    const ld = jsonLdPerson();
    const recruiter = recruiterLockup();
    const card = topCard();
    const cardText = card ? card.innerText || "" : "";

    const fullName = readFullName(ld, recruiter);
    const lineInfo = readTopCardLines(fullName);
    const headline = readHeadline(ld, recruiter) || lineInfo.headline;
    const location = readLocation(ld, recruiter) || lineInfo.location || null;

    const experience = readExperience();

    const worksFor = ld?.worksFor?.[0]?.name ? cleanCompany(ld.worksFor[0].name) : null;
    const jobTitle = Array.isArray(ld?.jobTitle) ? clean(ld.jobTitle[0]) : clean(ld?.jobTitle);
    const headlineSplit = splitHeadline(headline || recruiter?.headline);

    const panelCompany = topCardCompany(fullName, headline);
    const expCompany = companyFromExperience();
    const currentCompany =
      panelCompany ||
      expCompany ||
      experience[0]?.company ||
      headlineSplit.company ||
      worksFor ||
      null;

    const currentTitle =
      jobTitle ||
      headlineSplit.title ||
      experience[0]?.title ||
      recruiter?.headline ||
      headline ||
      null;

    const about =
      txt(sectionFor("about")?.querySelector('span[aria-hidden="true"]')) ||
      txt(sectionFor("about")) ||
      null;

    const degreeMatch = cardText.match(/\b(1st|2nd|3rd)\b/);
    const contact = readContact();

    const result = {
      fullName,
      headline,
      currentTitle,
      currentCompany,
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

    return result;
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
        .note {
          position: fixed; z-index: 2147483647; max-width: 320px;
          padding: 10px 12px; border-radius: 10px; background: #ffffff; color: #1c241f;
          border: 1px solid #d6dcd8; box-shadow: 0 6px 24px rgba(0,0,0,.18);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 12.5px; line-height: 1.45; cursor: pointer;
        }
        .note[hidden] { display: none; }
        .note p { margin: 0; }
        .note p + p { margin-top: 4px; }
        .note .found { color: #14663f; font-weight: 600; }
        .note .check { color: #8a5a00; font-weight: 600; }
        .note .tip { color: #5b6660; }
      </style>
      <div class="note" hidden title="Click to close"></div>
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

  /**
   * What our database said about the person just saved (1 Oct), in a note
   * above the button: already held, possibly someone to check, or new — and,
   * for a 1st-degree connection, a reminder that their email and phone are
   * only read with LinkedIn's Contact info open.
   */
  let noteTimer = null;
  function showNote(lines) {
    if (!root) return;
    const note = root.querySelector(".note");
    const bar = root.querySelector(".bar");
    note.replaceChildren(
      ...lines.map(([cls, text]) => {
        const p = document.createElement("p");
        if (cls) p.className = cls;
        p.textContent = text;
        return p;
      }),
    );
    const r = bar.getBoundingClientRect();
    note.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    note.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
    note.hidden = false;
    note.onclick = () => (note.hidden = true);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (note.hidden = true), 12000);
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
      const contactOpen = readContact().open;

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

      setState(res.status === "updated" ? "Already in the table — updated" : "Saved to the table", "ok");
      const m = res.match;
      showNote([
        res.status === "updated"
          ? ["", `Already in Excel Tables${res.addedByName ? `, added by ${res.addedByName}` : ""}. Updated, not added again.`]
          : ["", "Saved to Excel Tables."],
        m && m.strength === "same"
          ? ["found", `In our database: ${m.fullName}${m.hasCv ? " — CV on file" : " — no CV yet"}.`]
          : m && m.strength === "possible"
            ? ["check", `Possibly ${m.fullName}, already in our database. Check on the row in Excel Tables.`]
            : ["", "Not in our database yet — a new person. Use Find CV on the row if you think we have them."],
        !contactOpen && profile.connectionDegree === "1st" && !profile.email && !profile.phone
          ? ["tip", "Tip: open their Contact info before saving, to include their email and phone."]
          : null,
      ].filter(Boolean));
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
