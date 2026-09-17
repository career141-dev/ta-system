// convex/lib/screeningCall.ts
//
// The Aura screening call: what it is told, and what is kept from it.
//
// A TA presses Call on a candidate in Follow-up. The call runs in a browser
// room with the Aura voice agent (voice-agent/), modelled on the CV pipeline's
// Aura agent. It introduces itself as calling from Career141 about the role,
// then collects current salary, expected salary, notice period and the
// opening's own follow-up questions. When the call ends the transcript comes
// back, and the answers are read out of it and filled into the record.
//
// Pure: no Convex imports, tested on its own (tests/screeningcall.test.ts).

type QuestionJob = {
  agent5CustomQuestions?: string[];
  customFollowUpQuestions?: string[];
  followUpQuestions?: { id: string; label: string }[];
};

export type StandardField = "currentSalary" | "expectedSalary" | "noticePeriodDays";

/**
 * A job question that only repeats one of the three standard details — the CV
 * pipeline's jobs often carry "Current monthly salary" or "Notice period" as
 * their own questions. Aura asks those once, as the standard item.
 */
export function standardFieldOf(question: string): StandardField | null {
  const q = question.toLowerCase();
  if (/\bnotice\b/.test(q)) return "noticePeriodDays";
  if (/\b(salary|pay|package|compensation|ctc)\b/.test(q)) {
    if (/\b(expect|expected|expectation|looking for|desired|asking)\b/.test(q)) return "expectedSalary";
    if (/\b(current|present|now|existing|last)\b/.test(q)) return "currentSalary";
  }
  return null;
}

/** All the opening's own questions as set, once each (standard repeats included). */
export function allJobQuestions(job: QuestionJob): string[] {
  const all = [
    ...(job.followUpQuestions ?? []).map((q) => q.label),
    ...(job.customFollowUpQuestions ?? []),
    ...(job.agent5CustomQuestions ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const q = String(raw ?? "").trim();
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** The opening's own questions Aura asks: every one that is not a repeat of the standard three. */
export function screeningQuestions(job: QuestionJob): string[] {
  return allJobQuestions(job).filter((q) => standardFieldOf(q) === null).slice(0, 10);
}

/** Answers to job questions that repeat a standard detail, written from the figures the call collected. */
export function standardAnswers(questions: string[], a: Pick<CallAnswers, StandardField | "currentSalaryCurrency" | "expectedSalaryCurrency">): Record<string, string> {
  const out: Record<string, string> = {};
  const money = (n: number | null, c: string | null) => (n === null ? null : `${c ? `${c} ` : ""}${n.toLocaleString("en-US")}`);
  for (const q of questions) {
    const f = standardFieldOf(q);
    const v =
      f === "currentSalary" ? money(a.currentSalary, a.currentSalaryCurrency)
      : f === "expectedSalary" ? money(a.expectedSalary, a.expectedSalaryCurrency)
      : f === "noticePeriodDays" && a.noticePeriodDays !== null ? `${a.noticePeriodDays} days`
      : null;
    if (v) out[q] = v;
  }
  return out;
}

/** What the agent must collect, in the order it asks. */
export function detailsToCollect(jobTitle: string, questions: string[]): string[] {
  return [
    `Confirm they are still interested in the ${jobTitle} role`,
    "Their current monthly salary, with the currency",
    "Their expected monthly salary, with the currency",
    "Their notice period",
    ...questions,
  ].slice(0, 15);
}

type BriefJob = {
  title: string;
  clientName?: string;
  clientIndustry?: string;
  isConfidential?: boolean;
  location?: string;
  jobDescription?: string;
};

/** The call brief the agent answers job questions from. A confidential client is never named. */
export function callBrief(job: BriefJob): string {
  const client = job.isConfidential
    ? `A confidential client${job.clientIndustry ? ` in ${job.clientIndustry}` : ""}. Do not name or guess the company.`
    : job.clientName
      ? job.clientName
      : "Not stated";
  return [
    `Role: ${job.title}`,
    `Hiring company: ${client}`,
    job.location ? `Location: ${job.location}` : "",
    "",
    (job.jobDescription ?? "").trim().slice(0, 3000),
  ]
    .filter((l, i) => l !== "" || i === 3)
    .join("\n");
}

export type TranscriptLine = { who: "agent" | "candidate"; text: string };

export function transcriptText(lines: TranscriptLine[]): string {
  return lines
    .map((l) => `${l.who === "agent" ? "Aura" : "Candidate"}: ${l.text.trim()}`)
    .filter((l) => !l.endsWith(": "))
    .join("\n")
    .slice(0, 100_000);
}

/** Whether anybody answered: at least one real thing said on the candidate's side. */
export function candidateSpoke(lines: TranscriptLine[]): boolean {
  return lines.some((l) => l.who === "candidate" && l.text.trim().replace(/[^a-z0-9]/gi, "").length >= 2);
}

export function extractionPrompt(questions: string[], transcript: string): string {
  const custom = questions.length
    ? questions.map((q, i) => `  ${i + 1}. ${JSON.stringify(q)}`).join("\n")
    : "  (none)";
  return `Read this recruitment screening call transcript and return ONLY a JSON object.

Use only what the CANDIDATE said and confirmed. If something was not stated clearly, use null. Never guess.

{
  "interested": true | false | null,
  "currentSalary": number | null,         // monthly amount as a plain number, e.g. 150000 for "150k"
  "currentSalaryCurrency": string | null, // ISO code, e.g. "LKR", "USD"
  "expectedSalary": number | null,
  "expectedSalaryCurrency": string | null,
  "noticePeriodDays": number | null,      // "one month" = 30, "two weeks" = 14, "immediately" = 0
  "answers": { "<question exactly as written below>": "<the candidate's answer, short>" }
}

Questions for "answers" (use these exact strings as keys, omit any not answered):
${custom}

TRANSCRIPT:
${transcript}`;
}

export interface CallAnswers {
  interested: boolean | null;
  currentSalary: number | null;
  currentSalaryCurrency: string | null;
  expectedSalary: number | null;
  expectedSalaryCurrency: string | null;
  noticePeriodDays: number | null;
  answers: Record<string, string>;
}

const num = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
};
const currency = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null;

/**
 * What a model returned, made safe to write: numbers in range, a currency that
 * is a code, and answers only to questions that were actually asked.
 */
export function normaliseCallAnswers(raw: unknown, questions: string[]): CallAnswers {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const given = (r.answers && typeof r.answers === "object" ? r.answers : {}) as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const hit = Object.entries(given).find(([k]) => k.trim().toLowerCase() === q.toLowerCase());
    const a = hit ? String(hit[1] ?? "").trim() : "";
    if (a && !/^(null|n\/a|unknown|not (stated|answered|mentioned))$/i.test(a)) answers[q] = a.slice(0, 500);
  }
  return {
    interested: typeof r.interested === "boolean" ? r.interested : null,
    currentSalary: num(r.currentSalary, 1, 100_000_000),
    currentSalaryCurrency: currency(r.currentSalaryCurrency),
    expectedSalary: num(r.expectedSalary, 1, 100_000_000),
    expectedSalaryCurrency: currency(r.expectedSalaryCurrency),
    noticePeriodDays: num(r.noticePeriodDays, 0, 365),
    answers,
  };
}

/** Pull the JSON object out of a model reply that may wrap it in prose or a code fence. */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
