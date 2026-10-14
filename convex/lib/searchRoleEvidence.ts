/** Database search only. Occupation evidence must not be confused with a reporting line. */
import { parseCvDate } from "./experience";

export type SearchOccupation = {
  targetOccupation: string | null;
  equivalentTitles: string[];
  reportingContext: string | null;
  explicitSkills: string[];
  inferredSkills: string[];
};

export type RoleEvidence = {
  kind: "current" | "previous" | "broader";
  label: "Relevant current role" | "Relevant previous role" | "Broader match";
  title?: string;
  recency: number;
  matchedReportingContext?: string;
};

type Career = {
  currentTitle?: string | null;
  currentJobTitle?: string | null;
  currentEmployer?: string | null;
  summary?: string | null;
  pastJobTitles?: string[];
  jobHistory?: { title?: string; company?: string; startDate?: string; endDate?: string }[];
};

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
const distinct = (xs: string[]) => [...new Map(xs.filter(Boolean).map(x => [clean(x), x.trim()])).values()];
const SUPPORT = /\b(?:personal assistant|executive assistant|executive pa|executive secretary|confidential secretary|pa|ea)\b/i;

const contextKey = (text: string) => clean(text)
  .replace(/\bchief financial officer\b/g, "cfo")
  .replace(/\bchief executive officer\b/g, "ceo")
  .replace(/\bchief operating officer\b/g, "coo")
  .replace(/^(?:the|a|an)\s+/, "");

function reportingContext(title: string): string | null {
  const explicit = title.match(/\b(?:reporting to|reports to|supporting|to|for)\s+(.+)$/i)?.[1];
  if (explicit) return explicit.trim();
  return SUPPORT.test(title) ? title.match(/\b(cfo|ceo|coo|chief financial officer|chief executive officer|chief operating officer)\b/i)?.[0] ?? null : null;
}

function contextMatch(title: string, intent: SearchOccupation): string | undefined {
  const context = reportingContext(title);
  if (!context || !intent.reportingContext || !roleMatches(title, intent)) return undefined;
  // Context must belong to a supported occupation, not just occur in a CV or employer name.
  const wanted = contextKey(intent.reportingContext);
  return wanted && ` ${contextKey(context)} `.includes(` ${wanted} `) ? intent.reportingContext : undefined;
}

export function occupationTitle(title: string): string {
  const role = clean(title)
    .replace(/\bchief financial officer\b/g, "cfo")
    .replace(/\bchief executive officer\b/g, "ceo")
    .replace(/\b(?:reporting to|supporting|reports to|to the|to|for the|for|at)\b.*$/, "")
    .trim();
  const assistant = role.match(/^((?:senior|junior|lead)\s+)?(?:personal assistant|executive assistant|executive pa|pa|ea)(?:\s+(?:cfo|ceo))?$/);
  if (assistant) return `${assistant[1] ?? ""}personal assistant`;
  if (/^executive pa secretary$/.test(role)) return "personal assistant";
  return role;
}

/** Quick results keep the phrase, not a partial hit from the sampled vocabulary. */
export function quickRolePhrase(query: string): string {
  return query.split(/\n/)[0].trim()
    .replace(/^(?:please\s+)?(?:find|show|search for|looking for|need|suggest)(?:\s+me)?\s+(?:an?\s+)?/i, "")
    .split(/\b(?:with|who|in|having|must|prefer|at|from)\b|[,;]/i)[0].trim();
}

export function readOccupation(
  req: { title: string; alternativeTitles: string[]; occupationSynonyms: string[]; requiredSkills: string[]; preferredSkills: string[]; searchOccupation?: SearchOccupation },
  query: string,
  explicitChips: string[] = [],
): SearchOccupation {
  const supplied = req.searchOccupation;
  const phrase = supplied?.targetOccupation === null ? "" : supplied?.targetOccupation ?? req.title;
  const support = phrase.match(SUPPORT);
  let target = occupationTitle(phrase);
  if (support && /^(?:personal assistant|executive assistant|executive pa|pa|ea)(?:\s+(?:cfo|ceo))?$/.test(target)) target = "personal assistant";
  if (/^(?:everyone|anyone|people|candidates?|profiles?|position|professionals?|staff)(?:\s|$)/i.test(target)) target = "";
  const supportTarget = !!support && /^(?:(?:senior|junior|lead)\s+)?(?:personal assistant|executive assistant|executive pa|executive secretary|confidential secretary|pa|ea)$/.test(target);
  const equivalents = supportTarget
    ? ["Personal Assistant", "Executive Assistant", "Executive PA", "PA", "EA", "Executive Secretary", "Confidential Secretary"]
    : [...(supplied?.equivalentTitles ?? []), ...req.occupationSynonyms];
  const compatible = (title: string) => {
    const normalized = occupationTitle(title);
    // A model's broad alternatives must not turn Assistant Accountant into Accountant.
    return !!normalized && (supportTarget ? SUPPORT.test(normalized) : /\bassistant\b/.test(target) === /\bassistant\b/.test(normalized));
  };
  const explicit = distinct([...explicitChips, ...(supplied?.explicitSkills ?? req.requiredSkills.filter(s => ` ${clean(query)} `.includes(` ${clean(s)} `)))]);
  const inferred = distinct([...(supplied?.inferredSkills ?? []), ...req.requiredSkills, ...req.preferredSkills])
    .filter(s => !explicit.some(e => clean(e) === clean(s)));
  return {
    targetOccupation: target || null,
    equivalentTitles: distinct(equivalents.filter(compatible)),
    reportingContext: supplied ? supplied.reportingContext : reportingContext(req.title) ?? (supportTarget ? reportingContext(quickRolePhrase(query)) : null),
    explicitSkills: explicit,
    inferredSkills: inferred,
  };
}

export function roleMatches(title: string, intent: SearchOccupation): boolean {
  if (!intent.targetOccupation) return false;
  const candidate = occupationTitle(title);
  const variants = [intent.targetOccupation, ...intent.equivalentTitles].map(occupationTitle);
  const withoutLevel = (s: string) => s.replace(/^(?:senior|junior|lead)\s+/, "");
  return variants.some(v => candidate === v || withoutLevel(candidate) === withoutLevel(v));
}

const dateValue = (s?: string, end = false) => {
  const date = parseCvDate(s);
  if (!date || date.present) return 0;
  return end ? Date.UTC(date.y, date.m ?? 12, 1) - 1 : Date.UTC(date.y, (date.m ?? 1) - 1, 1);
};

export function roleEvidence(cv: Career, intent: SearchOccupation, asOf = new Date()): RoleEvidence | undefined {
  if (!intent.targetOccupation) return undefined;
  const current = cv.currentTitle || cv.currentJobTitle || "";
  const evidence: RoleEvidence[] = [];
  const add = (title: string, ongoing: boolean, recency = 0) => evidence.push({
    kind: ongoing ? "current" : "previous",
    label: ongoing ? "Relevant current role" : "Relevant previous role",
    title, recency, matchedReportingContext: contextMatch(title, intent),
  });
  const history = cv.jobHistory ?? [];
  const jobs = history.filter(j => dateValue(j.startDate) <= asOf.getTime());
  const sameCurrentJob = (j: NonNullable<Career["jobHistory"]>[number]) =>
    contextKey(j.title ?? "") === contextKey(current) && (!cv.currentEmployer || !j.company || clean(j.company) === clean(cv.currentEmployer));
  const currentJobs = history.filter(sameCurrentJob);
  const ended = (end?: string) => dateValue(end, true) > 0 && dateValue(end, true) < asOf.getTime();
  // A stored headline can outlive its job. Dated history takes precedence;
  // a different employer with the same title does not invalidate today's role.
  if (roleMatches(current, intent) && !currentJobs.length) add(current, true);
  for (const job of jobs) {
    if (!roleMatches(job.title ?? "", intent)) continue;
    const ongoing = !!parseCvDate(job.endDate)?.present || (!ended(job.endDate) && sameCurrentJob(job));
    add(job.title!, ongoing, dateValue(job.endDate, true) || dateValue(job.startDate));
  }
  for (const past of cv.pastJobTitles ?? []) if (roleMatches(past, intent)) add(past, false);
  // Summaries count only when they explicitly describe work in a role, not a mention of a boss.
  const summaryRoles = (cv.summary ?? "").slice(0, 500).matchAll(/\b(?:worked|served|employed)\s+as\s+(?:an?\s+)?([^.;,]+)/gi);
  for (const match of summaryRoles) {
    if (roleMatches(match[1], intent)) add(match[1].trim(), false);
  }
  // Do not stop at the first general PA job: earlier CFO-support work may be
  // the strongest evidence for this particular search.
  evidence.sort((a, b) => Number(!!b.matchedReportingContext) - Number(!!a.matchedReportingContext) || Number(b.kind === "current") - Number(a.kind === "current") || b.recency - a.recency);
  if (evidence.length) return evidence[0];
  return { kind: "broader", label: "Broader match", recency: 0 };
}

export function compareRoleEvidence(a?: RoleEvidence, b?: RoleEvidence): number {
  const priority = (e?: RoleEvidence) => !e ? 0 : e.kind === "broader" ? 1 : 0;
  return priority(a) - priority(b) || Number(!!b?.matchedReportingContext) - Number(!!a?.matchedReportingContext);
}

type SearchRank = { roleEvidence?: RoleEvidence; overallScore: number; titleScore: number; cv: { _id: string } };
export function compareSearchCandidates(a: SearchRank, b: SearchRank, scoreA = a.overallScore, scoreB = b.overallScore): number {
  return compareRoleEvidence(a.roleEvidence, b.roleEvidence) || scoreB - scoreA || b.titleScore - a.titleScore || (b.roleEvidence?.recency ?? 0) - (a.roleEvidence?.recency ?? 0) || a.cv._id.localeCompare(b.cv._id);
}

export function mergeSearchPool(keywordIds: string[], vectorIds: string[]): string[] {
  return [...new Set([...new Set(keywordIds)].slice(0, 200).concat([...new Set(vectorIds)].slice(0, 200)))];
}

type Ranked = { index: number; overallScore: number; skillScore: number; roleEvidence?: RoleEvidence };
export function searchReviewPool<T extends Ranked>(ranked: T[]): T[] {
  const supported = ranked.filter(c => c.roleEvidence && c.roleEvidence.kind !== "broader")
    .sort((a, b) => a.skillScore - b.skillScore || b.overallScore - a.overallScore);
  const uncertain = ranked.filter(c => !c.roleEvidence || c.roleEvidence.kind === "broader");
  const chosen = [...supported.slice(0, 10), ...uncertain.slice(0, 10)];
  const seen = new Set(chosen.map(c => c.index));
  for (const c of [...supported.slice(10), ...uncertain.slice(10)]) {
    if (chosen.length >= 20) break;
    if (!seen.has(c.index)) { chosen.push(c); seen.add(c.index); }
  }
  return chosen;
}

export function searchEvidenceReason(evidence: RoleEvidence | undefined, title: string, verify: string[]): string {
  const label = evidence ? `${evidence.label}${evidence.title ? `: ${evidence.title}` : ""}.` : `Profile: ${title || "role not stated"}.`;
  return `${label}${evidence?.matchedReportingContext ? ` Matches requested reporting context: ${evidence.matchedReportingContext}.` : ""}${verify.length ? ` Verify: ${verify.slice(0, 3).join(", ")}.` : ""}`;
}
