import "server-only";

/**
 * Referral Search, run from the web app (8 Oct).
 *
 * The sentence is read here, not in the backend: Claude's subscription runs in
 * this process (src/lib/claudeBridge), so it is asked directly, the way database
 * search does. Then the backend finds the people (convex/ta/referenceSearch) —
 * no model there, so the same criteria give the same list.
 *
 * Claude first, DeepSeek second, the plain words last. The reading depends on
 * nothing but the sentence, so it is kept for a few minutes: paging, a removed
 * chip and a reload do not ask a model again.
 */
import { askBridge } from "@/lib/claudeBridge";
import { convexQuery } from "@/lib/convexServer";
import { maxModelCost, modelCost, reserve } from "@/lib/spend";
import { readCriteria, type ReferralCriteria, type ReadVia } from "../../convex/lib/referralSearch";

export type ReferralPerson = {
  id: string;
  name: string;
  designation: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  at: number;
  why: string[];
  namedByCount: number;
  namedBy: { id: string; fullName: string; title: string; employer: string }[];
};

export type ReferralAnswer = {
  criteria: ReferralCriteria;
  via: ReadVia;
  summary: string;
  total: number;
  deep: boolean;
  titleMissed: boolean;
  people: ReferralPerson[];
};

const KEEP_MS = 5 * 60_000;
const KEEP_MAX = 200;
const reads = new Map<string, { at: number; value: Promise<{ criteria: ReferralCriteria; via: ReadVia }> }>();

async function askDeepSeek(system: string, prompt: string): Promise<string | null> {
  const { getOpenAI, OPENROUTER_PRIMARY_MODEL } = await import("../../convex/lib/llm");
  const settle = reserve("referral search: read the query", maxModelCost(OPENROUTER_PRIMARY_MODEL, system.length + prompt.length, 500));
  try {
    const res = await getOpenAI("jd_extraction", 20_000).chat.completions.create({
      model: OPENROUTER_PRIMARY_MODEL,
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      // A structured read needs no reasoning, and DeepSeek can spend its whole budget on it.
      ...({ reasoning: { enabled: false } } as object),
    });
    settle(modelCost(OPENROUTER_PRIMARY_MODEL, res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0));
    return res.choices[0]?.message?.content ?? null;
  } catch (e) {
    settle(0);
    throw e;
  }
}

async function askClaude(system: string, prompt: string): Promise<string | null> {
  const r = await askBridge({ task: "match_read", system, prompt });
  if (!r.ok) console.warn(`[referral-search] claude → deepseek: ${r.reason}`);
  return r.ok ? r.text : null;
}

export function readReferralQuery(text: string) {
  const key = text.replace(/\s+/g, " ").trim().toLowerCase();
  const held = reads.get(key);
  if (held && Date.now() - held.at < KEEP_MS) return held.value;
  const value = readCriteria(text, { claude: askClaude, deepseek: askDeepSeek });
  reads.set(key, { at: Date.now(), value });
  value.catch(() => reads.delete(key));
  while (reads.size > KEEP_MAX) reads.delete(reads.keys().next().value!);
  return value;
}

/** The chips a TA took off: the search runs without those titles or companies. */
export function withoutTerms(c: ReferralCriteria, drop: string[]): ReferralCriteria {
  if (!drop.length) return c;
  const gone = new Set(drop.map((d) => d.toLowerCase()));
  const keep = (xs: string[]) => xs.filter((x) => !gone.has(x.toLowerCase()));
  return { ...c, designations: keep(c.designations), companies: keep(c.companies) };
}

export async function referralSearch(text: string, drop: string[], actorId: string | null): Promise<ReferralAnswer> {
  const { criteria: read, via } = await readReferralQuery(text);
  const criteria = withoutTerms(read, drop);
  const found = await convexQuery<Omit<ReferralAnswer, "criteria" | "via">>("ta/referenceSearch:search", {
    ...(actorId ? { actorId } : {}),
    criteria,
  });
  return { criteria: read, via, ...found };
}
