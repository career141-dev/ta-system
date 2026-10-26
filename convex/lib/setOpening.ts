// convex/lib/setOpening.ts
//
// The opening a TA's set subject means, when the strict reader
// (shortlistMail.matchHouseSubject) cannot tell (26 October). Of 220 set
// emails since 10 October, 102 named their opening the way the desk talks —
// "Q COLLECTION (BD) > GM OPS", "DELTA SPIKE > SOC ANALYST - TDR", "AKBAR
// BROTHERS > CUSTOMER SERVICE MANAGER" — not the way the opening is titled.
// Pure; tested in tests/setopening.test.ts.

import { sameClient } from "./interviewMail";
import type { HouseSubject, OpeningLite } from "./shortlistMail";

/** The desk's names for a client that share no word with the opening's. */
const CLIENT_ALIAS: [RegExp, string][] = [
  [/^q\s*collection\s*\(?bd\)?$/i, "SQ - BD"],
];

/** The desk's short forms, spelled out as the openings are titled. */
const POSITION_ALIAS: [RegExp, string][] = [
  [/\bsoc\b/gi, "security operations center"],
  [/\bgm\b/gi, "general manager"],
  [/\bops\b/gi, "operations"],
  [/\bie\b/gi, "industrial engineering"],
  [/\bpd\b/gi, "product development"],
  [/\bam\b/gi, "assistant manager"],
  [/\bcustomer service\b/gi, "customer experience"],
  [/\bgarment tech\b/gi, "garment technology"],
  [/\belectrical engineer(ing)?\b/gi, "executive electrical"],
  [/\bmanagement accountant\b/gi, "management accounting"],
  [/\bhr manager\b/gi, "manager hr"],
  [/\bbranding\b/gi, "brand"],
];

/** What is not the position: "02 CV's", "ATTEMPT 02", "FOLLOW UPS", "(TESTING…)", the country. */
const NOISE = [/\b\d+\s*cv'?s?\b/gi, /\battempt\s*\d+/gi, /\bfollow\s*ups?\b/gi, /\(testing[^)]*\)?/gi, /\b(bangladesh|vietnam)\b/gi, /\b2nd\s*slot\b/gi, /\bcolombo\b.*$/gi];

// "HR" and "IT" are words here; "of" and "and" are not.
const STOP = new Set(["of", "and", "the", "at", "for", "to"]);
const titleWords = (s: string) => [...new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w)))];

export function readPosition(position: string): string {
  let p = position;
  for (const n of NOISE) p = p.replace(n, " ");
  for (const [re, to] of POSITION_ALIAS) p = p.replace(re, to);
  return p.replace(/\s+/g, " ").trim();
}

/**
 * The openings the subject fits best — more than one only when they fit it
 * equally (the same opening entered twice, as DeltaSpike's Finance Manager
 * is). An opening's title words the subject lacks count a little against it,
 * so "HEAD OF HR" is Head of HR, not Group Head of HR.
 */
export function setOpenings(house: Pick<HouseSubject, "client" | "position">, openings: OpeningLite[]): OpeningLite[] {
  const client = CLIENT_ALIAS.find(([re]) => re.test(house.client.trim()))?.[1] ?? house.client;
  const want = titleWords(readPosition(house.position));
  const scored = openings
    .filter((o) => sameClient(client, o.clientName))
    .map((o) => {
      const title = titleWords(o.title);
      const hit = want.filter((w) => title.includes(w)).length;
      return { o, hit, score: hit - 0.1 * (title.length - hit) };
    })
    // More than half the subject's words and half the title's: "HEAD OF QUALITY" shares only "head" with Head of Planning.
    .filter((x) => x.hit >= 1 && x.hit > want.length / 2 && x.hit >= titleWords(x.o.title).length / 2)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  return scored.filter((x) => Math.abs(x.score - scored[0].score) < 1e-9).map((x) => x.o);
}
