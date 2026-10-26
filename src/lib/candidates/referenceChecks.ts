import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";
import { canonicalProfile, displayUrl, type SearchResult } from "@/lib/serper";
import { profileFacts } from "@/lib/sourcing";
import { isPlausibleReferee } from "../../../convex/lib/refereeCheck";

export interface RefereeSearchDeps extends Pick<OpeningWriteDeps, "convexQuery"> {
  searchConfigured: () => boolean;
  search: (query: string, limit: number) => Promise<SearchResult>;
}

export type RefereeCheckResult =
  | { ok: true; message: string; profileUrl: string }
  | { ok: false; status: 400 | 403 | 404 | 503; message: string; notice?: boolean };

/** One LinkedIn referee check shared by the web action and the native route. */
export async function checkCandidateReferee(
  user: User,
  openingId: string,
  refereeId: string,
  applicationId: string | null,
  deps: RefereeSearchDeps,
): Promise<RefereeCheckResult> {
  const app = applicationId ? repo.application(applicationId) : null;
  if (applicationId && (!app || app.openingId !== openingId)) {
    return { ok: false, status: 404, message: "That candidate is not on this opening." };
  }
  const decision = await decideOn(user, "opening.sourcing", { openingId }, deps);
  if (!decision.ok) return decision;

  const referees = app
    ? repo.referees().filter((row) => row.fromCandidateId === app.candidateId && isPlausibleReferee({
        name: row.name,
        contactNo: row.phone,
        email: row.email,
        company: row.company,
        designation: row.title,
      }))
    : repo.refereesForPipeline(openingId).flatMap((group) => group.referees);
  const referee = referees.find((row) => row.id === refereeId);
  if (!referee) {
    return { ok: false, status: 404, message: "That referee is not on this opening's list any more. Reload the page." };
  }
  if (!deps.searchConfigured()) {
    return { ok: false, status: 503, message: "Web search is not set up on this system, so LinkedIn cannot be checked." };
  }

  const first = referee.name.split(/\s+/).filter((word) => word.length > 1 && !/^(dr|mr|mrs|ms|prof)\.?$/i.test(word))[0]?.toLowerCase() ?? "";
  if (!first) {
    return { ok: false, status: 400, notice: true, message: `${referee.name} is too short a name to match on LinkedIn. Check by hand, or call them.` };
  }
  const query = `"${referee.name}"${referee.company ? ` "${referee.company}"` : ""} site:linkedin.com/in`;
  const result = await deps.search(query, 5);
  if (result.error) return { ok: false, status: 503, message: `The search did not run (${result.error}). Try again.` };
  const hit = result.hits.find((row) => canonicalProfile(row.url) && row.title.toLowerCase().includes(first));
  if (!hit) {
    return {
      ok: false,
      status: 404,
      notice: true,
      message: `No LinkedIn profile found for ${referee.name}${referee.company ? ` at ${referee.company}` : ""}. Check by hand, or call them.`,
    };
  }

  const canonical = canonicalProfile(hit.url)!;
  const parts = hit.title.replace(/\s*\|\s*LinkedIn.*$/i, "").split(/\s+[-–—]\s+/);
  const title = (parts[1] ?? "").replace(/\s+(?:at|@)\s+.+$/i, "").trim() || null;
  const company = profileFacts({ title: hit.title, snippets: [hit.snippet] }).company;
  const now = [title, company && `at ${company}`].filter(Boolean).join(" ") || "role not shown in the search result";
  const cv = [referee.title, referee.company && `at ${referee.company}`].filter(Boolean).join(" ");
  const same = Boolean(company && referee.company && employerMatches(company, referee.company));
  const profileUrl = displayUrl(canonical);
  return {
    ok: true,
    profileUrl,
    message: `LinkedIn today: ${now}.${cv ? ` The CV says ${cv}${same ? " — same company." : " — this may be out of date."}` : ""} Profile: ${profileUrl}`,
  };
}

/** "Hayleys PLC" and "hayleys" are the same employer for this check. */
function employerMatches(a: string, b: string): boolean {
  const key = (value: string) => value.toLowerCase().replace(/\b(plc|pvt|ltd|limited|inc|llc|group|\(pvt\))\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const left = key(a);
  const right = key(b);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}
