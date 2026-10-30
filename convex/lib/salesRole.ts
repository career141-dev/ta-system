/**
 * Is this person in sales, and at what level (30 Oct).
 *
 * Built for the Extras tab's sales contact list, which feeds email campaigns.
 * Title rules rather than an AI read: free over 78,000 candidates, the same
 * answer every run, and every row says which rule caught it.
 *
 * Pure, with no database or network, so the backend, the app and the tests share it.
 */

export type SalesLevel = "intern" | "manager" | "executive" | "other";

export type SalesRoleInput = {
  currentJobTitle?: string | null;
  currentTitle?: string | null;
  jobHistory?: { title?: string | null; company?: string | null; startDate?: string | null }[] | null;
  pastJobTitles?: string[] | null;
  skills?: string[] | null;
  sector?: string | null;
};

export type SalesRole = {
  level: SalesLevel;
  title: string;
  titleSource: "current" | "history" | "older history";
  matchedBy: string;
};

const SALES = /\b(sales|business development|bdm|bde|bdo|telesales|tele-sales|account (manager|executive|director)|key account|territory|relationship manager|pre-?sales|field (sales|executive)|area (sales|manager))\b/i;
// "Sales Accountant" and friends sell nothing; marketing/support titles that only mention sales are left out too.
const NOT_SALES = /\b(sales (accountant|clerk|coordinator|support|admin(istrator)?|analyst|data|operations|ops|engineer(ing)?|finance)|accountant|payroll|customer (service|support)|marketing (executive|manager|officer)$)\b/i;
const INTERN = /\b(intern|interns|internship|trainee|apprentice)\b/i;
const MANAGER = /\b(manager|head|director|vp|vice president|chief|cso|cro|lead|supervisor|general manager|gm|bdm|asm|rsm)\b/i;
const EXECUTIVE = /\b(executive|officer|associate|specialist|bde|bdo|consultant|representative|rep)\b/i;
// A bare "Executive" or "Officer" is sales only when the CV's own skills or sector say so.
const VAGUE = /^(senior |junior |jr\.? |sr\.? )?(executive|officer|associate|consultant)$/i;
const SALES_SKILL = /\b(sales|business development|lead generation|b2b|b2c|cold call|negotiation|account management|crm)\b/i;

const startKey = (d?: string | null) => {
  const m = /(\d{4})(?:[-/](\d{1,2}))?/.exec(d ?? "");
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : 0;
};

/** The title to read: current, else the latest dated job, else the first older one. */
export function titleToRead(c: SalesRoleInput): { title: string; source: SalesRole["titleSource"] } | null {
  const current = (c.currentJobTitle ?? c.currentTitle ?? "").trim();
  if (current) return { title: current, source: "current" };
  const latest = [...(c.jobHistory ?? [])]
    .filter((j) => (j.title ?? "").trim())
    .sort((a, b) => startKey(b.startDate) - startKey(a.startDate))[0];
  if (latest) return { title: latest.title!.trim(), source: "history" };
  const old = (c.pastJobTitles ?? []).map((t) => t.trim()).find(Boolean);
  return old ? { title: old, source: "older history" } : null;
}

export function salesLevelOf(title: string): SalesLevel {
  // Intern first: "Sales Manager Trainee" is a trainee.
  if (INTERN.test(title)) return "intern";
  if (MANAGER.test(title)) return "manager";
  if (EXECUTIVE.test(title)) return "executive";
  return "other";
}

export function salesRoleOf(c: SalesRoleInput): SalesRole | null {
  const read = titleToRead(c);
  if (!read) return null;
  const { title, source } = read;
  if (NOT_SALES.test(title)) return null;
  let matchedBy = SALES.exec(title)?.[0].toLowerCase();
  if (!matchedBy && VAGUE.test(title) && ((c.skills ?? []).some((s) => SALES_SKILL.test(s)) || /sales/i.test(c.sector ?? "")))
    matchedBy = "bare title + sales skills";
  if (!matchedBy) return null;
  return { level: salesLevelOf(title), title, titleSource: source, matchedBy };
}
