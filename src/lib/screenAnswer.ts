/**
 * The screen answer (prompt v3) and how it is checked (14 September).
 *
 * Two separate questions:
 *   1. Is the answer structurally valid? Every required field present, every
 *      value one of the allowed ones. If not, the answer is invalid; it is never
 *      repaired into a result.
 *   2. Does it hold together? Evidence quotes that are empty where required or
 *      not found in what the model was given, and gate/decision combinations
 *      that contradict the prompt's own rules, are flagged for evaluation. They
 *      do not change the decision; they are reported beside it.
 *
 * `tools/embed/score_screen.py` applies the same rules to laptop results.
 */

export type Decision = "shortlist" | "maybe" | "reject";

export interface ScreenAnswer {
  industry: { result: "pass" | "fail" | "unclear" | "not_stated"; quote: string };
  level: { current: string; job: string; result: "pass" | "fail" | "unclear"; quote: string };
  work: { type: string; result: "pass" | "related" | "fail" | "unclear"; quote: string };
  essentials_contradicted: { item: string; quote: string }[];
  essentials_missing: string[];
  move: "step_up" | "lateral" | "step_down" | "unclear";
  decision: Decision;
  reason: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): v is T => isStr(v) && (xs as readonly string[]).includes(v);

/** Structural problems; empty means valid. */
export function answerProblems(v: unknown): string[] {
  const p: string[] = [];
  if (!isObj(v)) return ["not an object"];
  const gate = (name: string, results: readonly string[], extra: string[] = []) => {
    const g = v[name];
    if (!isObj(g)) return p.push(`${name} missing`);
    if (!oneOf(g.result, results)) p.push(`${name}.result not one of ${results.join("|")}`);
    if (!isStr(g.quote)) p.push(`${name}.quote missing`);
    for (const f of extra) if (!isStr(g[f]) || !(g[f] as string).trim()) p.push(`${name}.${f} missing`);
  };
  gate("industry", ["pass", "fail", "unclear", "not_stated"]);
  gate("level", ["pass", "fail", "unclear"], ["current", "job"]);
  gate("work", ["pass", "related", "fail", "unclear"], ["type"]);
  if (!Array.isArray(v.essentials_contradicted) || !v.essentials_contradicted.every((e) => isObj(e) && isStr(e.item) && isStr(e.quote))) p.push("essentials_contradicted malformed");
  if (!Array.isArray(v.essentials_missing) || !v.essentials_missing.every(isStr)) p.push("essentials_missing malformed");
  if (!oneOf(v.move, ["step_up", "lateral", "step_down", "unclear"])) p.push("move not allowed");
  if (!oneOf(v.decision, ["shortlist", "maybe", "reject"])) p.push("decision not allowed");
  if (!isStr(v.reason) || !v.reason.trim()) p.push("reason missing");
  return p;
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Consistency flags for evaluation. `given` is the exact text the model was sent. */
export function answerFlags(a: ScreenAnswer, given: string): string[] {
  const f: string[] = [];
  const hay = norm(given);
  const found = (q: string) => !q.trim() || hay.includes(norm(q));
  const gates = [["industry", a.industry], ["level", a.level], ["work", a.work]] as const;
  for (const [name, g] of gates) {
    if (g.result === "fail" && !g.quote.trim()) f.push(`${name} failed without a quote`);
    if (g.quote.trim() && !found(g.quote)) f.push(`${name} quote not found in the input`);
  }
  for (const e of a.essentials_contradicted) {
    if (!e.quote.trim()) f.push(`contradicted "${e.item.slice(0, 40)}" without a quote`);
    else if (!found(e.quote)) f.push(`contradicted "${e.item.slice(0, 40)}" quote not found in the input`);
  }
  const anyFail = gates.some(([, g]) => g.result === "fail") || a.essentials_contradicted.length > 0;
  const anyUnclear = gates.some(([, g]) => g.result === "unclear") || a.work.result === "related";
  if (a.decision === "reject" && !anyFail) f.push("reject with no failed gate or contradicted essential");
  if (a.decision !== "reject" && anyFail) f.push(`${a.decision} despite a failed gate or contradicted essential`);
  if (a.decision === "shortlist" && (anyUnclear || a.move === "lateral" || a.move === "step_down")) f.push("shortlist despite an unclear gate, related work or a lateral/step-down move");
  return f;
}
