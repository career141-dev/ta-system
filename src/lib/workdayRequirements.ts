import type { WorkdayCheck, WorkType } from "./workday";
import { isEodSendCheck } from "./workday";
import { validateResearchLink } from "./eod-format";
import { externalUrl } from "./url";

export const RESEARCH_FIELDS = ["similarDesignation", "websiteLink", "servicesProvider", "country", "location", "competitors", "socialMedia", "companyOverview"] as const;
// 14 Oct: pause the workday requirement while Suggestions is being revisited.
// The sourcing feature and its saved review evidence remain available.
export const SUGGESTIONS_WORKDAY_REQUIRED: boolean = false;
export const RESEARCH_LABELS: Record<typeof RESEARCH_FIELDS[number], string> = { similarDesignation: "Similar designation", websiteLink: "Company website", servicesProvider: "Services offered", country: "Country", location: "Location", competitors: "Competitors", socialMedia: "Social media", companyOverview: "Company overview" };
export const researchVersion = (report: { generatedAt: number; fields: unknown } | null) =>
  report ? JSON.stringify([report.generatedAt, report.fields]) : "";
/** A later Add-on session must not inherit an earlier session's submission. */
export function workSessionStart(entry: { workType: WorkType; addedAt: number; modeHistory: { at: number; workType: string }[] }) {
  return entry.workType === "Add-on" ? entry.modeHistory.filter(h => h.workType === "Add-on").at(-1)?.at ?? entry.addedAt : entry.addedAt;
}
export function researchMissing(fields: Record<string, unknown>, reasons: Record<string, string>) {
  return RESEARCH_FIELDS.filter((key) => {
    const value = fields[key];
    const sourced = (v: unknown) => typeof v === "string" && !!v.trim() && !/^(n\/?a|unknown|not available|tbd|-)$/i.test(v.trim());
    const filled = Array.isArray(value) ? value.some(sourced) : sourced(value);
    return !filled && !reasons[key]?.trim();
  });
}
export function linkedinPostUrl(value: string | null | undefined) {
  try {
    const u = new URL(externalUrl(value) ?? "");
    return u.protocol === "https:" && (u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com")) && /^\/(jobs\/view\/|posts\/|feed\/update\/)/.test(u.pathname);
  } catch { return false; }
}

export interface SetupEvidence {
  jobId: string; workType: WorkType; userId: string;
  jd?: { version: string; approved: boolean; reviewedVersion?: string; at?: number; by?: string };
  post?: { id: string; at?: number; by?: string };
  research: { version: string; reviewedVersion?: string; missing: string[]; unavailable?: string[]; at?: number; by?: string };
  suggestions: { successful: boolean; pending: number; count: number; version: string; emptyReason?: string; at?: number; by?: string };
  profiles: { count: number; at?: number };
  ready: number; submitted: number; noCandidateReason?: string; noCandidateAt?: number;
  chatgptLink?: string; confirmedAt?: number;
  emailAt?: number;
}

/** The same saved evidence drives sidebar ticks, send preflight and Finish. */
export function setupChecks(e: SetupEvidence, includeSuggestions = SUGGESTIONS_WORKDAY_REQUIRED): WorkdayCheck[] {
  const base = `/openings/${e.jobId}`;
  const rows: WorkdayCheck[] = [];
  const add = (key: string, label: string, href: string, complete: boolean, progress: string,
    at?: number, by?: string, evidence?: string, blocksEmail = true) => {
    rows.push({ key: `${key}:${e.jobId}`, jobId: e.jobId, label, href, kind: key === "daily_email" ? "email" : "details",
      canCarry: false, evidenceAt: at ?? 0, status: complete ? "complete" : "incomplete",
      completedAt: complete ? at : undefined, completedBy: complete ? by : undefined, progress, evidence, blocksEmail });
  };
  if (e.workType === "100%") {
    const jdReviewed = !!e.jd?.version.trim() && e.jd.approved && e.jd.version === e.jd.reviewedVersion;
    add("jd_review", "Job description reviewed", `${base}/jd`, jdReviewed,
      !e.jd?.version.trim() ? "Create the job description" : !e.jd.approved ? "Review and approve the job description" : jdReviewed ? "Reviewed and confirmed" : "Confirm your review of the approved job description",
      e.jd?.at, e.jd?.by, `jd:${e.jobId}`);
    add("linkedin_post", "LinkedIn job post", `${base}/linkedin-job`, !!e.post, e.post ? "Connected" : "Add a LinkedIn job or post link", e.post?.at, e.post?.by, e.post?.id);
    const reviewed = !!e.research.version && e.research.version === e.research.reviewedVersion && !e.research.missing.length;
    add("research", "Research fields reviewed", `${base}/hh/research`, reviewed,
      e.research.missing.length ? `Missing: ${e.research.missing.map(key => RESEARCH_LABELS[key as typeof RESEARCH_FIELDS[number]] ?? key).join(", ")}` : reviewed ? ["Reviewed", ...(e.research.unavailable ?? [])].join(" · ") : "Confirm your review", e.research.at, e.research.by, e.research.version);
    const suggestionsDone = e.suggestions.successful && !e.suggestions.pending && (e.suggestions.count > 0 || !!e.suggestions.emptyReason?.trim());
    add("suggestions", "Suggestions reviewed", `${base}/hh/suggestions`, suggestionsDone,
      !e.suggestions.successful ? "Run Suggestions successfully" : e.suggestions.pending ? `${e.suggestions.pending} to review` : !e.suggestions.count ? e.suggestions.emptyReason || "Record why the search returned no profiles" : "All reviewed",
      e.suggestions.at, e.suggestions.by, e.suggestions.version);
    rows[rows.length - 1].needsEmptySuggestionsReason = e.suggestions.successful &&
      e.suggestions.count === 0 && !e.suggestions.emptyReason?.trim();
    add("excel_profiles", "Own Excel Tables profiles", `${base}/hh/links`, e.profiles.count >= 3, `${e.profiles.count}/3`, e.profiles.at, e.userId, String(e.profiles.count));
  }
  if (e.workType !== "Follow-up") {
    const complete = e.ready > 0 || e.submitted > 0 || !!e.noCandidateReason?.trim();
    add("director_candidate", "Director Review candidate or explanation", `${base}/eod`, complete,
      e.submitted ? `${e.submitted} submitted` : e.ready ? `${e.ready} ready` : e.noCandidateReason || "Move a suitable candidate to Director Review, or record why none were found",
      e.noCandidateAt, e.userId, e.noCandidateReason);
  }
  const validLink = validateResearchLink(e.chatgptLink);
  add("chatgpt", "ChatGPT research link", `${base}/eod`, validLink.ok && !!e.confirmedAt,
    validLink.ok ? e.confirmedAt ? "Link confirmed" : "Confirm the link" : validLink.reason,
    e.confirmedAt, e.userId, validLink.ok ? validLink.url : undefined);
  add("daily_email", "End-of-day email", `${base}/eod`, !!e.emailAt,
    e.emailAt ? "Sent and recorded" : "Send the daily email", e.emailAt, e.userId, undefined, false);
  return (includeSuggestions ? rows : rows.filter(c => !c.key.startsWith("suggestions:")))
    .map(c => ({ ...c, blocksEmail: isEodSendCheck(c) }));
}
