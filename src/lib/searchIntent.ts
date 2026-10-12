import { turnsOf } from "@/lib/query";

export type SearchIntentStrictness = "strict" | "balanced" | "flexible";

export interface SearchClarifyingQuestion {
  id: string;
  label: string;
  options: { label: string; turn: string }[];
}

export interface SearchIntent {
  targetRole: string | null;
  mustHave: string[];
  niceToHave: string[];
  dealBreakers: string[];
  softPreferences: string[];
  strictness: SearchIntentStrictness;
  unknowns: string[];
  clarifyingQuestions: SearchClarifyingQuestion[];
  summary: string;
}

export interface EngineIntentHints {
  mustHave: string[];
  niceToHave: string[];
  dealBreakers: string[];
  strictness: SearchIntentStrictness;
}

export const EMPTY_SEARCH_INTENT: SearchIntent = {
  targetRole: null,
  mustHave: [],
  niceToHave: [],
  dealBreakers: [],
  softPreferences: [],
  strictness: "balanced",
  unknowns: [],
  clarifyingQuestions: [],
  summary: "",
};

const STOP = /\b(?:with|who|that|for|from|at|in|around|near|must|needs?|required|prefer|preferred|ideally|avoid|exclude|not)\b/i;
const ROLE_PREFIX = /^(?:find me|find|show me|show|search for|search|looking for|look for|we need|i need|need|want|give me|source)\s+(?:an|a|the|some)?\s*/i;
const LIST_SPLIT = /\s*(?:,|;|\/|\band\b|\bor\b|\bplus\b|\bwith\b)\s*/i;

export function readSearchIntent(turnsOrQuery: string[] | string, previousIntent?: SearchIntent | null): SearchIntent {
  const turns = Array.isArray(turnsOrQuery) ? turnsOrQuery : turnsOf(turnsOrQuery);
  const next = normalizeIntent({
    ...EMPTY_SEARCH_INTENT,
    targetRole: targetRoleFrom(turns),
    mustHave: extractMustHave(turns),
    niceToHave: extractNiceToHave(turns),
    dealBreakers: extractDealBreakers(turns),
    softPreferences: extractSoftPreferences(turns),
    strictness: strictnessFrom(turns),
  });
  return previousIntent ? mergeSearchIntent(previousIntent, next) : withDerived(next);
}

export function mergeSearchIntent(previousIntent: SearchIntent | null | undefined, newTurnIntent: SearchIntent): SearchIntent {
  if (!previousIntent) return withDerived(normalizeIntent(newTurnIntent));
  return withDerived(normalizeIntent({
    ...previousIntent,
    targetRole: newTurnIntent.targetRole ?? previousIntent.targetRole,
    mustHave: mergeList(previousIntent.mustHave, newTurnIntent.mustHave),
    niceToHave: mergeList(previousIntent.niceToHave, newTurnIntent.niceToHave),
    dealBreakers: mergeList(previousIntent.dealBreakers, newTurnIntent.dealBreakers),
    softPreferences: mergeList(previousIntent.softPreferences, newTurnIntent.softPreferences),
    strictness: newTurnIntent.strictness !== "balanced" ? newTurnIntent.strictness : previousIntent.strictness,
  }));
}

export function intentToEngineHints(intent: SearchIntent): EngineIntentHints {
  return {
    mustHave: intent.mustHave.filter((x) => x.length >= 2).slice(0, 6),
    niceToHave: intent.niceToHave.filter((x) => x.length >= 2).slice(0, 6),
    dealBreakers: intent.dealBreakers.filter((x) => x.length >= 2).slice(0, 6),
    strictness: intent.strictness,
  };
}

export function intentToClarifyingQuestions(intent: SearchIntent, resultStats?: { total?: number }): SearchClarifyingQuestion[] {
  const questions: SearchClarifyingQuestion[] = [];
  const unknowns = new Set(intent.unknowns);

  if (unknowns.has("location_strictness")) {
    questions.push({
      id: "location_strictness",
      label: "Should location be strict or flexible?",
      options: [
        { label: "Strict location", turn: "Location is strict." },
        { label: "Flexible nearby", turn: "Location is flexible; nearby candidates are okay." },
      ],
    });
  }

  if (unknowns.has("domain_priority")) {
    questions.push({
      id: "domain_priority",
      label: "Is the named industry required or only preferred?",
      options: [
        { label: "Required", turn: "Industry experience is required." },
        { label: "Preferred", turn: "Industry experience is preferred, not required." },
      ],
    });
  }

  if (unknowns.has("overqualification")) {
    questions.push({
      id: "overqualification",
      label: "Should I avoid overqualified profiles?",
      options: [
        { label: "Avoid overqualified", turn: "Avoid overqualified profiles." },
        { label: "Include stretch profiles", turn: "Senior stretch profiles are okay." },
      ],
    });
  }

  if (questions.length < 2 && (resultStats?.total ?? 1) > 0 && !intent.softPreferences.some((p) => /senior|overqualified|stretch/i.test(p))) {
    questions.push({
      id: "seniority_tolerance",
      label: "Should seniority be tight or can strong stretch profiles appear?",
      options: [
        { label: "Keep it tight", turn: "Keep seniority close to the requested role." },
        { label: "Allow stretch", turn: "Strong stretch profiles are okay." },
      ],
    });
  }

  return questions.slice(0, 2);
}

export function appendSearchTurn(query: string, turn: string): string {
  const prior = turnsOf(query);
  return [...prior, turn.trim()].filter(Boolean).join("\n").slice(0, 4000);
}

function withDerived(intent: SearchIntent): SearchIntent {
  const unknowns = unknownsFor(intent);
  const base = { ...intent, unknowns };
  return {
    ...base,
    clarifyingQuestions: intentToClarifyingQuestions(base),
    summary: summaryFor(base),
  };
}

function normalizeIntent(intent: SearchIntent): SearchIntent {
  return {
    ...intent,
    targetRole: cleanPhrase(intent.targetRole ?? "") || null,
    mustHave: uniqueClean(intent.mustHave),
    niceToHave: uniqueClean(intent.niceToHave),
    dealBreakers: uniqueClean(intent.dealBreakers),
    softPreferences: uniqueClean(intent.softPreferences),
  };
}

function targetRoleFrom(turns: string[]): string | null {
  for (const turn of turns) {
    const stripped = turn.replace(ROLE_PREFIX, "").trim();
    const [role] = stripped.split(STOP);
    const clean = cleanPhrase(role);
    if (clean && !/^(actually|instead|prefer|open|flexible|avoid|not)\b/i.test(clean)) return clean;
  }
  return null;
}

function extractMustHave(turns: string[]): string[] {
  return extractAfter(turns, [
    /\bmust\s+have\s+([^.;\n]+)/gi,
    /\brequired(?:\s+skills?|\s+experience)?\s*(?:is|are|:)?\s*([^.;\n]+)/gi,
    /\bneeds?\s+(?:to\s+have\s+)?([^.;\n]+)/gi,
  ]).filter((x) => !/^(a|an|the)\s+/i.test(x));
}

function extractNiceToHave(turns: string[]): string[] {
  return extractAfter(turns, [
    /\bnice\s+to\s+have\s+([^.;\n]+)/gi,
    /\bprefer(?:red|ably)?\s+([^.;\n]+)/gi,
    /\bideally\s+([^.;\n]+)/gi,
    /\bbonus\s+(?:for|if)?\s*([^.;\n]+)/gi,
  ]);
}

function extractDealBreakers(turns: string[]): string[] {
  return extractAfter(turns, [
    /\bavoid\s+([^.;\n]+)/gi,
    /\bexclude\s+([^.;\n]+)/gi,
    /\bnot\s+from\s+([^.;\n]+)/gi,
    /\bnot\s+([^.;\n]+)/gi,
  ]);
}

function extractSoftPreferences(turns: string[]): string[] {
  const out = extractAfter(turns, [
    /\bopen\s+to\s+([^.;\n]+)/gi,
    /\bflexible\s+(?:on|with|about)?\s*([^.;\n]+)/gi,
    /\bnearby\s+([^.;\n]+)/gi,
    /\bfor\s+(manufacturing|fmcg|banking|finance|apparel|retail|hospitality|healthcare)\b/gi,
  ]);
  for (const turn of turns) {
    if (/\bprefer\b/i.test(turn) && /\bopen\b|\bflexible\b/i.test(turn)) out.push(turn);
    if (/\bnearby\b/i.test(turn)) out.push("nearby candidates");
    if (/\bstretch profiles?\b|\boverqualified\b|\bseniority\b/i.test(turn)) out.push(turn);
  }
  return out;
}

function strictnessFrom(turns: string[]): SearchIntentStrictness {
  const text = turns.join(" ").toLowerCase();
  if (/\b(strict|must|required|only|avoid|exclude|deal[- ]?breaker)\b/.test(text)) return "strict";
  if (/\b(prefer|preferred|ideally|open|flexible|nearby|nice to have)\b/.test(text)) return "flexible";
  return "balanced";
}

function unknownsFor(intent: SearchIntent): string[] {
  const unknowns: string[] = [];
  const all = [intent.targetRole ?? "", ...intent.mustHave, ...intent.niceToHave, ...intent.softPreferences].join(" ").toLowerCase();
  if (!/\b(strict|flexible|nearby|remote|colombo|kandy|galle|negombo|location)\b/.test(all)) unknowns.push("location_strictness");
  if (/\b(manufacturing|fmcg|banking|finance|apparel|retail|hospitality|healthcare)\b/.test(all) && !/\b(required|must|preferred|prefer)\b/.test(all)) {
    unknowns.push("domain_priority");
  }
  if (!/\b(overqualified|stretch|seniority|junior|senior)\b/.test(all)) unknowns.push("overqualification");
  return unknowns;
}

function summaryFor(intent: SearchIntent): string {
  const parts = [
    intent.targetRole ? `Looking for ${intent.targetRole}` : "Looking for relevant candidates",
    intent.mustHave.length ? `must have ${intent.mustHave.slice(0, 3).join(", ")}` : null,
    intent.niceToHave.length ? `prefers ${intent.niceToHave.slice(0, 3).join(", ")}` : null,
    intent.dealBreakers.length ? `avoids ${intent.dealBreakers.slice(0, 3).join(", ")}` : null,
  ].filter(Boolean);
  return `${parts.join("; ")}. Strictness: ${intent.strictness}.`;
}

function extractAfter(turns: string[], patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(turn))) {
        out.push(...splitPhrases(match[1] ?? ""));
      }
    }
  }
  return out;
}

function splitPhrases(text: string): string[] {
  return text.split(LIST_SPLIT).map(cleanPhrase).filter(Boolean);
}

function cleanPhrase(text: string): string {
  return text
    .replace(/[()"]/g, "")
    .replace(/\b(?:please|candidate|candidates|profiles?|people|someone|person)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;.,-]+|[\s:;.,-]+$/g, "")
    .slice(0, 90)
    .trim();
}

function uniqueClean(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values.map(cleanPhrase).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function mergeList(a: string[], b: string[]): string[] {
  return uniqueClean([...a, ...b]);
}
