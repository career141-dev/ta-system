/**
 * CV intake — the door, and the lock on it.
 *
 * The live system ingests from three places: a WhatsApp number (Meta Cloud
 * API), a mailbox, and folder uploads. All three write straight through
 * extraction into the candidate table; a duplicate is merged or dropped by
 * `createCandidate` and nobody is told which.
 *
 * Here everything lands in a QUEUE first. A queued item is not a candidate: it
 * is a file that arrived, with whatever could be read out of it and whatever
 * dedup made of that, waiting for a TA to admit it, merge it or throw it out.
 * That one change is what makes "we received 40, kept 6, and here is the other
 * 34" answerable, and it is what stops a thin CV overwriting a full record.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT ACTIVE.
 *
 * Every channel that reaches outside this machine — the mailbox, the WhatsApp
 * number, the storage bucket holding the real CVs — is built and wired and
 * switched OFF, and stays off until the two systems are merged and you say so.
 * The switch is one environment variable, deliberately not a checkbox in the
 * UI: turning on live intake pulls real people's CVs into this build, and that
 * should take a deploy and a decision, not a misclick.
 *
 * What works today is `upload` and `extension`: a file a TA hands over
 * themselves, and the LinkedIn capture they pressed a button for. Both are
 * already in front of the person doing them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from "node:crypto";
import type { IntakeSource, ParsedCv } from "@/data/types";
import { emailKey, linkedinKey, phoneKey } from "./dedup";

// ───────────────────────────────────────────────────────────────── channels ──

export interface Channel {
  source: IntakeSource;
  label: string;
  /** What it connects to, so the settings screen says something true. */
  detail: string;
  /** Whether it reaches outside this machine for other people's data. */
  external: boolean;
  /** What still has to happen before it can be turned on. */
  blockedBy: string | null;
}

export const CHANNELS: Channel[] = [
  {
    source: "upload",
    label: "Manual upload",
    detail: "A TA drops a file into the queue themselves.",
    external: false,
    blockedBy: null,
  },
  {
    source: "extension",
    label: "LinkedIn capture",
    detail: "The browser extension, on a profile the TA has open and pressed the button on.",
    external: false,
    blockedBy: null,
  },
  {
    source: "email",
    label: "Mailbox",
    detail: "Applications arriving at the advertised address, with the CV attached.",
    external: true,
    blockedBy: "Live mailbox credentials, and the merge with the existing system.",
  },
  {
    source: "whatsapp",
    label: "WhatsApp",
    detail: "The campaign number, via the Meta Cloud API. Carries the campaign keyword, so the CV arrives already attached to an opening.",
    external: true,
    blockedBy: "Meta Cloud API token, and the merge with the existing system.",
  },
  {
    source: "portal",
    label: "Job board feeds",
    detail: "Applications pulled back from the boards an opening was posted to.",
    external: true,
    blockedBy: "Per-board credentials, and the merge with the existing system.",
  },
];

/**
 * The one switch. Off unless the environment says otherwise, and off on any
 * value other than an explicit `on`, because a half-set variable should fail
 * closed.
 */
export function liveIntakeEnabled(): boolean {
  return (process.env.C141_INTAKE_LIVE ?? "").trim().toLowerCase() === "on";
}

export interface ChannelState {
  channel: Channel;
  /** Whether a file may actually enter the queue through it right now. */
  open: boolean;
  why: string;
}

export function channelState(source: IntakeSource): ChannelState {
  const channel = CHANNELS.find((c) => c.source === source)!;
  if (!channel.external) {
    return { channel, open: true, why: "A person is doing this by hand." };
  }
  if (!liveIntakeEnabled()) {
    return {
      channel,
      open: false,
      why: "Built, not switched on. Live intake is off for this build.",
    };
  }
  if (channel.blockedBy) {
    return { channel, open: false, why: channel.blockedBy };
  }
  return { channel, open: true, why: "Live." };
}

export function channelStates(): ChannelState[] {
  return CHANNELS.map((c) => channelState(c.source));
}

/** Called by every path that would bring a file in. Returns the refusal rather
 *  than throwing, so a closed channel is reported, not crashed on. */
export function guard(source: IntakeSource): { ok: true } | { ok: false; message: string } {
  const s = channelState(source);
  return s.open ? { ok: true } : { ok: false, message: s.why };
}

// ─────────────────────────────────────────────────────────────────── parsing ──

/**
 * What a CV is read for, before any model is involved.
 *
 * Deliberately not a stub that invents plausible values — same rule as brief
 * extraction. A field the system guessed wrong is worse than a field a TA has
 * to fill in: the first is a mistake nobody notices, the second is two
 * seconds. So every field here is either READ out of the text or left null,
 * and `readFields` records which is which.
 *
 * At connection the live `cvExtraction` model runs first and this stays as the
 * fallback for when it is unavailable or returns nothing — the signature is
 * the same either way.
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[^\s,;)]+/i;

/**
 * Phone numbers and the numbers that are not phone numbers.
 *
 * A CV is full of long digit runs that will happily match a loose pattern:
 * the NIC, a passport number, a date, a postcode, a salary. Reading one of
 * those as a phone number is worse than reading none, because it becomes a
 * dedup key and merges two strangers. So the match is anchored on the shapes
 * a Sri Lankan number actually takes, and anything sitting next to an
 * identity-document word is discarded.
 */
const NOT_PHONE = /\b(nic|n\.i\.c|passport|id\s*(?:no|number)|index|reg(?:istration)?\s*no|postal|zip)\b/i;
const PHONE_RE =
  /(?:\+?94[\s-]?|0)(?:7\d|1\d|2\d|3\d|4\d|5\d|6\d|8\d|9\d)[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\d[\d\s-]{7,13}\d\b/g;

function firstPhone(text: string): string | null {
  for (const m of text.matchAll(PHONE_RE)) {
    // Only what sits BEFORE the number on its own line — that is where the
    // label is. A window that reaches past the line break reads the next
    // field's label instead, and on a CV the line after the mobile number is
    // very often the NIC, which then discards every phone number on the page.
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const label = text.slice(lineStart, m.index);
    if (NOT_PHONE.test(label)) continue;
    if (phoneKey(m[0])) return m[0].trim();
  }
  return null;
}

/**
 * The name is the hardest field and the most damaging to get wrong, so it is
 * only taken from the top of the document and only in a shape that reads like
 * a name — never from a line that has already been identified as something
 * else.
 */
function readName(lines: string[]): string | null {
  const skip = /(curriculum vitae|resume|c\.?v\.?|profile|personal (details|information)|contact)/i;
  for (const line of lines.slice(0, 8)) {
    const t = line.trim();
    if (!t || t.length > 60) continue;
    if (skip.test(t)) continue;
    if (EMAIL_RE.test(t) || LINKEDIN_RE.test(t) || /\d{4}/.test(t)) continue;
    const words = t.replace(/[^\p{L}\s.'-]/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 7) continue;
    // A line of ordinary sentence case is prose, not a name.
    const capitalised = words.filter((w) => /^[\p{Lu}]/u.test(w)).length;
    if (capitalised < words.length - 1) continue;
    return words.join(" ");
  }
  return null;
}

function readLabelled(text: string, labels: string[]): string | null {
  for (const l of labels) {
    const m = text.match(new RegExp(`^\\s*${l}\\s*[:\\-–]\\s*(.{2,80})$`, "im"));
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ");
  }
  return null;
}

/** "8 years of experience", "over 12 years". Only where the sentence says so —
 *  totalling employment dates is a different job and a lossier one. */
function readYears(text: string): number | null {
  const m = text.match(/\b(?:over\s+|more than\s+|about\s+)?(\d{1,2})(?:\+)?\s*(?:\.\d)?\s*years?\b[^.\n]{0,30}\b(?:experience|exp\b)/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 50) return n;
  }
  return null;
}

const DEGREE_RE =
  /\b(b\.?sc|b\.?a\b|b\.?eng|bba|b\.?com|m\.?sc|m\.?ba|mba|m\.?a\b|ph\.?d|hnd|higher national diploma|diploma|cima|acca|aat|cma|llb|mbbs)\b[^.\n]{0,70}/i;

/**
 * Skills are only taken from a section that says it is one. Harvesting nouns
 * out of prose produces a list that looks authoritative and is not.
 *
 * Walked line by line rather than matched as one block: a block pattern has to
 * guess where the section ends, and guesses wrong on the CVs that put two
 * headings together or run the list straight into the next section.
 */
const SKILL_HEADING = /^\s*(?:key\s+|core\s+|technical\s+|professional\s+)?(?:skills?|competenc(?:y|ies)|strengths)\s*[:\-–]?\s*(.*)$/i;
const HEADING_LIKE = /^\s*[\p{Lu}][\p{L} &/']{2,34}\s*[:\-–]?\s*$/u;

function readSkills(lines: string[]): string[] {
  const start = lines.findIndex((l) => SKILL_HEADING.test(l));
  if (start < 0) return [];

  // A heading may carry the list on its own line: "Skills: Excel, SAP".
  const collected: string[] = [lines[start].match(SKILL_HEADING)?.[1] ?? ""];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const bare = line.trim();
    const isBullet = /^[-*•·>]/.test(bare);
    if (!bare) {
      // A blank line ends the section once it has produced something; before
      // that it is just the space under the heading.
      if (collected.some((c) => c.trim())) break;
      continue;
    }
    if (!isBullet && HEADING_LIKE.test(line) && collected.some((c) => c.trim())) break;
    collected.push(bare);
  }

  return [
    ...new Set(
      collected
        .flatMap((l) => l.split(/[,;•·|]/))
        .map((s) => s.replace(/^[-*>\s]+/, "").replace(/[.\s]+$/, "").trim())
        .filter((s) => s.length >= 2 && s.length <= 40),
    ),
  ].slice(0, 30);
}

export function parseCv(rawText: string): ParsedCv {
  const text = rawText.replace(/\r/g, "");
  const lines = text.split("\n");
  const read: string[] = [];
  const take = <T,>(field: string, v: T | null): T | null => {
    if (v !== null && v !== undefined && v !== "") read.push(field);
    return v ?? null;
  };

  const email = take("email", text.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null);
  const linkedinRaw = text.match(LINKEDIN_RE)?.[0] ?? null;
  const linkedinUrl = take(
    "linkedinUrl",
    linkedinKey(linkedinRaw) ? `https://www.linkedin.com/in/${linkedinKey(linkedinRaw)}` : null,
  );
  const phone = take("phone", firstPhone(text));
  const fullName = take("fullName", readLabelled(text, ["name", "full name"]) ?? readName(lines));

  const currentTitle = take(
    "currentTitle",
    readLabelled(text, ["position", "designation", "current role", "job title", "title"]),
  );
  const currentEmployer = take(
    "currentEmployer",
    readLabelled(text, ["employer", "company", "current employer", "organisation", "organization"]),
  );
  const location = take("location", readLabelled(text, ["location", "address", "city", "based in"]));

  const degreeLine = text.match(DEGREE_RE)?.[0]?.trim() ?? null;
  const educationDegree = take("educationDegree", degreeLine);
  const educationInstitution = take(
    "educationInstitution",
    readLabelled(text, ["university", "institution", "institute", "college"]),
  );

  const totalExperienceYears = take("totalExperienceYears", readYears(text));

  const skills = readSkills(lines);
  if (skills.length) read.push("skills");

  return {
    fullName,
    email: email && emailKey(email) ? email : null,
    phone,
    linkedinUrl,
    location,
    currentTitle,
    currentEmployer,
    totalExperienceYears,
    educationDegree,
    educationInstitution,
    skills,
    readFields: read,
  };
}

/** What could not be read, stated rather than left as a silent blank. Only the
 *  fields that actually stop the record being usable. */
export function problemsWith(p: ParsedCv): string[] {
  const out: string[] = [];
  if (!p.fullName) out.push("No name could be read — the file may be a scan or a photograph.");
  if (!p.email && !p.phone && !p.linkedinUrl)
    out.push("No email, phone or LinkedIn. Nothing to dedup on and no way to reach them.");
  else {
    if (!p.email) out.push("No email address.");
    if (!p.phone) out.push("No phone number.");
  }
  if (!p.currentTitle && !p.currentEmployer) out.push("No current role or employer.");
  return out;
}
