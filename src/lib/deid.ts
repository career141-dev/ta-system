/**
 * De-identifying CV text before it leaves the machine (14 September).
 *
 * The first version dropped any line with seven or more digits in a row, which
 * also dropped "2015 - 2019" and removed employment dates from 54 of 120 CVs.
 * This one replaces the identifying details themselves and keeps the line:
 * emails (including "name @ gmail.com"), links, phone numbers, NIC and passport
 * numbers, home addresses, dates of birth, age, gender, marital status,
 * religion, the candidate's name, and a name-only header line.
 *
 * It de-identifies; it does not make a CV anonymous. A distinctive employer and
 * career can still point to a person. `residualContacts` is the check run on
 * the exact text that would be sent; a manual read of a sample is still needed.
 */

const EMAIL = /[A-Za-z0-9._%+\-\[\]]+\s*@\s*[A-Za-z0-9-]+(?:\s[A-Za-z0-9-]+)?(?:\s*\.\s*[A-Za-z0-9-]+)*\s*\.\s*[A-Za-z]{2,}/g;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b(?:[a-z]{2,3}\.)?linkedin\.com\/?\S*/gi;
/** Sri Lankan NIC: 9 digits + V/X (old) or 12 digits (new). */
const NIC = /\b\d{9}\s?[VvXx]\b|\b(?:19|20)\d{10}\b/g;
/** A run of digits, spaces, dots, dashes, slashes and brackets, optionally starting with +. */
const NUMBER_RUN = /\+?\(?\d[\d\s().\/-]{6,}\d/g;
/** A phone typed one digit at a time: "0 7 7 1 2 3 4 5 6 7". */
const SPACED_DIGITS = /\b\d(?:[ \t]\d){8,14}\b/g;

/** Labelled personal fields: the label stays, the value up to the next label or line end goes. */
const NEXT_LABEL = String.raw`(?=\s+(?:mobile|mob|tel|telephone|phone|e-?mail|email|address|linkedin|nationality|gender|sex|marital|religion|date of birth|dob|age|nic|passport|driving)\b|$)`;
const LABELLED: { type: keyof DeidResult["replaced"]; re: RegExp }[] = [
  { type: "address", re: new RegExp(String.raw`\b((?:permanent |postal |home |residential )?address)\b\s*(?:[:\-–]\s*|(?=(?:no\.?\s*)?\d)).+?${NEXT_LABEL}`, "gim") },
  { type: "dob", re: new RegExp(String.raw`\b(date of birth|d\.?o\.?b|birth ?day|born(?: on)?)\b\.?\s*(?:[:\-–]\s*|(?=\d)).+?${NEXT_LABEL}`, "gim") },
  { type: "personal", re: new RegExp(String.raw`\b(age|gender|sex|marital status|civil status|religion)\s*[:\-–]\s*.+?${NEXT_LABEL}`, "gim") },
  // The same labels at the start of a line with no colon ("Address Hanwella, Sri Lanka"): case-sensitive, so the verb "address" in a sentence is not touched.
  { type: "address", re: new RegExp(String.raw`^(\s*(?:Permanent |Postal |Home |Residential )?(?:Address|ADDRESS))\s+(?=[A-Z0-9]).+?${NEXT_LABEL}`, "gm") },
  { type: "personal", re: new RegExp(String.raw`^(\s*(?:Marital Status|MARITAL STATUS|Civil Status|Religion|RELIGION|Gender|GENDER|Sex|Age))\s+(?=[A-Z0-9]).+?${NEXT_LABEL}`, "gm") },
  { type: "phone", re: /\b(tp|tel|telephone|mobile|mob|phone|contact(?: no\.?| number)?|hotline|whats ?app)\s*[:\-–]\s*[\d+()\s\/\-]{6,}\d/gim },
  { type: "id", re: new RegExp(String.raw`\b(passport(?: no\.?| number)?|n\.?i\.?c\.?(?: no\.?| number)?|national identity card(?: no\.?| number)?|driving licen[cs]e(?: no\.?| number)?)\s*[:\-–]?\s*[A-Z]?\s?(?=[A-Z]{0,2}\d)[\dA-Z]{6,12}\b`, "gim") },
];

/** A street address on its own, wherever it sits: a house number, up to three parts, and a street word. */
const STREET = String.raw`(?:road|rd\.|mawatha|lane|street|st\.|place|avenue|waththa|watta|estate|gardens|terrace|junction|housing scheme)`;
const ADDRESS_FREE = new RegExp(String.raw`(?:\bno\.?\s*)?\b\d+[A-Za-z]?(?:[\/\-][\dA-Za-z]+)*\s*,\s*(?:[^,\n]{1,40},\s*){0,3}[^,\n]{0,40}?\b${STREET}\b(?:\s*,\s*[A-Z][A-Za-z()]+(?:\s[A-Z][A-Za-z()]+)?(?=\s*(?:,|$)))*\s*,?`, "gim");
/** Sri Lankan house addresses often have no street word: "No 12/3, Gaminipura, Hatton". */
const ADDRESS_HOUSE = /(?:\b(?:[Hh]ome|[Aa]ddress)\s*:?\s*)?\b(?:[Nn][Oo])\s*[.:]?\s*\d+[A-Za-z]?(?:[\/\-][\dA-Za-z]+)*[ \t,]+(?:[A-Z][A-Za-z.]*[ \t,]*){1,6}/gm;
const ADDRESS_SLASH = /\b\d+\/\d*[A-Za-z]?\s*,(?:\s*[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?\s*,){1,3}/g;
/** Staff actions stamped by the legacy system: "Azeem Ansar updated candidate". */
const STAFF_FOOTER = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}\s+(updated|viewed|downloaded|shortlisted|moved|added) candidate\b/g;
/** A person named with an honorific: referees, contacts. */
const HONORIFIC_NAME = /\b(?:Mr|Mrs|Ms|Miss|Dr|Rev|Prof)\.?[ \t]+(?:(?:[A-Z]\.[ \t]*){1,5}|(?:[A-Z][ \t]){1,5})?[A-Z][a-z]+(?:[ \t]+(?:De|Da|Van|Di)?[ \t]*[A-Z][a-z]+){0,3}/g;
const REFEREE_HEADING = /^\s*(?:non[- ]?related\s+)?(?:referees?|references?)\s*:?\s*$/i;
const NEXT_SECTION = /^\s*(?:education|academic|professional|experience|employment|work|career|skills|declaration|qualifications?|achievements?|languages?|interests?|hobbies|profile|summary|projects?|certifications?|training|personal)\b[^a-z]*$/i;
const ADDRESS_NO = /^\s*no\.?\s*\d+[\w\/\-]*\s*,(?:\s*[^,\n]{1,30},?){1,4}\s*$/gim;
/** Legacy system footers name the staff member who opened the CV. */
const VIEWED_BY = /\b([Vv]iewed|[Dd]ownloaded|[Uu]ploaded) by\s+[A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+){0,3}/g;
/** A date of birth split from its label by the PDF layout: a full date with a birth year, alone on a line. */
const BIRTH_DATE_ALONE = /^\s*\d{1,2}(?:st|nd|rd|th)?[\s\/.\-]+(?:\d{1,2}|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)[\s\/.\-,]+(?:19[4-9]\d|200\d)\s*$/gim;
const PERSONAL_ALONE = /^\s*(?:married|single|unmarried|male|female|buddhism|buddhist|islam|muslim|christian|catholic|hindu|hinduism)\s*[.,]?\s*$/gim;

/** True when a digit run is a phone number rather than dates, years or money. */
function isPhone(run: string): boolean {
  const digits = run.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return false;
  const groups = run.split(/[^\d]+/).filter(Boolean);
  if (groups.every((g) => /^(19|20)\d{2}$/.test(g) || g.length <= 2)) return false;
  if (/^\d{1,2}[./-]\d{1,2}[./-](19|20)?\d{2}/.test(run.trim())) return false;
  return /^\+/.test(run.trim()) || /^0\d/.test(digits) || /^94\d{9}$/.test(digits) || /^7\d{8}$/.test(digits) || digits.length >= 10;
}

export interface DeidResult {
  text: string;
  replaced: { email: number; url: number; nic: number; phone: number; name: number; address: number; dob: number; personal: number; id: number; header: number; referees: number };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameParts = (fullName: string | null | undefined) => (fullName ?? "").split(/[\s.]+/).filter((w) => w.replace(/\W/g, "").length > 2);

/** A first line that is only a person's name: 2–5 capitalised words, no digits, no job words. */
function isNameHeader(line: string): boolean {
  const t = line.trim();
  if (!t || /\d|@|:/.test(t) || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (/\b(curriculum|vitae|resume|résumé|profile|manager|engineer|executive|director|officer|head|senior|assistant|lead|specialist|analyst|consultant|accountant|summary)\b/i.test(t)) return false;
  return words.every((w) => /^[A-Z][A-Za-z'’\-.]*$/.test(w) || /^[A-Z.]+$/.test(w));
}

export function deidentify(text: string, fullName: string | null | undefined): DeidResult {
  const replaced: DeidResult["replaced"] = { email: 0, url: 0, nic: 0, phone: 0, name: 0, address: 0, dob: 0, personal: 0, id: 0, header: 0, referees: 0 };
  let t = text;
  // Referees are other people's details and play no part in screening: drop the section.
  {
    const ls = t.split("\n");
    const out: string[] = [];
    let skipping = false;
    for (const l of ls) {
      if (REFEREE_HEADING.test(l)) { skipping = true; out.push("[referees removed]"); replaced.referees++; continue; }
      if (skipping && NEXT_SECTION.test(l)) skipping = false;
      if (!skipping) out.push(l);
    }
    t = out.join("\n");
  }
  // A name-only header in the first three non-empty lines (the record's name can differ from the CV's).
  const lines = t.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 3; i++) {
    if (!lines[i].trim()) continue;
    seen++;
    if (isNameHeader(lines[i])) { lines[i] = "[name]"; replaced.header++; }
  }
  t = lines.join("\n");
  t = t.replace(EMAIL, () => (replaced.email++, "[email]"));
  // "Manager @ Company": an @ with a space on both sides means "at", not an address.
  t = t.replace(/(\S)\s+@\s+(?=\S)/g, "$1 at ");
  t = t.replace(URL, () => (replaced.url++, "[link]"));
  for (const { type, re } of LABELLED) t = t.replace(re, (_m, label: string) => (replaced[type]++, `${label}: [removed]`));
  t = t.replace(VIEWED_BY, (_m, verb: string) => (replaced.name++, `${verb} by [name]`));
  t = t.replace(STAFF_FOOTER, (_m, verb: string) => (replaced.name++, `[name] ${verb} candidate`));
  t = t.replace(HONORIFIC_NAME, () => (replaced.name++, "[name]"));
  t = t.replace(ADDRESS_FREE, () => (replaced.address++, "[address]"));
  t = t.replace(ADDRESS_HOUSE, () => (replaced.address++, "[address]"));
  t = t.replace(ADDRESS_SLASH, () => (replaced.address++, "[address]"));
  t = t.replace(ADDRESS_NO, () => (replaced.address++, "[address]"));
  t = t.replace(BIRTH_DATE_ALONE, () => (replaced.dob++, "[date]"));
  t = t.replace(PERSONAL_ALONE, () => (replaced.personal++, "[removed]"));
  t = t.replace(SPACED_DIGITS, () => (replaced.phone++, "[phone]"));
  t = t.replace(NIC, () => (replaced.nic++, "[id]"));
  t = t.replace(NUMBER_RUN, (m) => (isPhone(m) || m.split(/\s*\/\s*/).some(isPhone) ? (replaced.phone++, "[phone]") : m));
  for (const part of nameParts(fullName)) {
    t = t.replace(new RegExp(`\\b${esc(part)}\\b`, "gi"), () => (replaced.name++, "[name]"));
  }
  return { text: t, replaced };
}

/** Identifying details still present in text that is about to be sent. Empty means none found by these checks. */
export function residualContacts(text: string, fullName?: string | null): { type: string; sample: string }[] {
  const found: { type: string; sample: string }[] = [];
  const mask = (s: string) => s.replace(/[A-Za-z0-9]/g, (c, i) => (i < 2 ? c : "•")).slice(0, 12);
  for (const m of text.match(EMAIL) ?? []) found.push({ type: "email", sample: mask(m) });
  if (/[A-Za-z0-9]\s*@\s*[A-Za-z0-9]/.test(text)) found.push({ type: "at-sign", sample: "@" });
  for (const m of text.match(URL) ?? []) found.push({ type: "url", sample: mask(m) });
  for (const m of text.match(NIC) ?? []) found.push({ type: "nic", sample: mask(m) });
  for (const m of text.match(SPACED_DIGITS) ?? []) found.push({ type: "phone", sample: mask(m) });
  for (const m of text.match(NUMBER_RUN) ?? []) if (isPhone(m) || m.split(/\s*\/\s*/).some(isPhone)) found.push({ type: "phone", sample: mask(m) });
  for (const { type, re } of LABELLED) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (!/\[removed\]/.test(m[0])) found.push({ type, sample: mask(m[0]) });
    }
  }
  for (const m of text.match(new RegExp(ADDRESS_FREE.source, "gi")) ?? []) found.push({ type: "address", sample: mask(m) });
  for (const m of text.match(new RegExp(VIEWED_BY.source, "g")) ?? []) found.push({ type: "staff-name", sample: mask(m) });
  for (const m of text.match(new RegExp(ADDRESS_HOUSE.source, "gim")) ?? []) found.push({ type: "address", sample: mask(m) });
  for (const m of text.match(new RegExp(STAFF_FOOTER.source, "g")) ?? []) if (!/^\[name\]/.test(m)) found.push({ type: "staff-name", sample: mask(m) });
  for (const m of text.match(new RegExp(HONORIFIC_NAME.source, "g")) ?? []) found.push({ type: "honorific-name", sample: mask(m) });
  for (const part of nameParts(fullName)) {
    if (new RegExp(`\\b${esc(part)}\\b`, "i").test(text)) found.push({ type: "name", sample: mask(part) });
  }
  return found;
}
