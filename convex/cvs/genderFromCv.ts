// A candidate's gender, read from their CV — never guessed.
//
// TA search hides a candidate whose stored gender does not match the query
// (src/lib/match.ts), so a wrong value costs a real person a shortlist while a
// blank one only says "gender not on file". Only certain signals count, in this
// order: the CV states it, the Sri Lankan NIC number encodes it, or the model
// read a title or pronoun used for the candidate. Nothing from the name or the
// photo (29 September). Kept free of Node imports so tests can load it.

import { birthFromNic, NIC_LABELLED, NIC_OLD_BARE } from "../lib/candidateAge";

export type Gender = "Male" | "Female";
export type GenderSource = "cv_stated" | "nic" | "cv_llm";

// "Male"/"Female" is what the search query parser (src/lib/query.ts) produces.
export function normaliseGender(s: unknown): Gender | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (t === "male" || t === "m" || t === "man") return "Male";
  if (t === "female" || t === "f" || t === "woman") return "Female";
  return null;
}

// Two readings that disagree are no reading.
function agree(found: Gender[]): Gender | null {
  const set = new Set(found);
  return set.size === 1 ? found[0] : null;
}

// "Gender: Male", "Sex : F", "GENDER - Female", "Gender/Sex Male", and the
// table layout where the value lands on the next line.
const LABEL = /\b(?:gender|sex)(?:[ \t]*\/[ \t]*(?:gender|sex))?[ \t]*[:\-–]?[ \t]*\n?[ \t]*(male|female|m|f)\b(?![.\/]?\w)/gi;

export function genderFromLabel(text: string): Gender | null {
  const found: Gender[] = [];
  for (const m of text.matchAll(LABEL)) {
    const g = normaliseGender(m[1]);
    if (g) found.push(g);
  }
  return agree(found);
}

// A Sri Lankan NIC carries the birth day of the year, plus 500 for women:
// old "853456789V" — digits 3–5; new "198534567890" — digits 5–7. The NIC is
// found the way lib/candidateAge finds it for the birth date (a labelled
// number, or the unmistakable nine-digits-and-V), and must decode to a real
// date, so a phone or account number of the same shape is never read.
export function nicGender(nic: string): Gender | null {
  if (!birthFromNic(nic)) return null;
  const digits = nic.replace(/[^\d]/g, "");
  const day = digits.length === 9 ? Number(digits.slice(2, 5)) : Number(digits.slice(4, 7));
  return day > 500 ? "Female" : "Male";
}

export function genderFromNic(text: string): Gender | null {
  const found: Gender[] = [];
  for (const re of [NIC_LABELLED, NIC_OLD_BARE]) {
    for (const m of text.matchAll(re)) {
      const g = nicGender(m[1]);
      if (g) found.push(g);
    }
  }
  return agree(found);
}

export function resolveGender({ rawText, llmGender }: { rawText?: string | null; llmGender?: unknown }): { gender: Gender; source: GenderSource } | null {
  const text = rawText ?? "";
  const stated = genderFromLabel(text);
  if (stated) return { gender: stated, source: "cv_stated" };
  const nic = genderFromNic(text);
  if (nic) return { gender: nic, source: "nic" };
  const llm = normaliseGender(llmGender);
  if (llm) return { gender: llm, source: "cv_llm" };
  return null;
}
