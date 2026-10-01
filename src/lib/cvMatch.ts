import "server-only";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import type { CvMatch, Id } from "@/data/types";
import { convexMutation, convexQuery } from "@/lib/convexServer";
import { cvSearchScore, jobYears, samePerson, type Job } from "../../convex/lib/samePerson";

/**
 * Match an Excel Tables row — a LinkedIn profile — to the candidate we already
 * hold, if we hold them (28 Sep; the rules are convex/lib/samePerson).
 *
 * Run when a profile arrives: added by hand, kept from Suggestions, or captured
 * by the extension. A certain match links the row to that candidate at once,
 * so shortlisting them uses the CV already on file and makes no second record;
 * a possible one is left for a TA to answer. A row already linked, or already
 * answered, is left alone.
 */
export async function matchLink(entryId: Id, actorId?: Id): Promise<CvMatch | null> {
  const e = repo.linkEntry(entryId);
  if (!e || e.candidateId || e.cvMatch?.decided) return e?.cvMatch ?? null;
  const cap = e.capture ?? null;
  const profile = {
    linkedinUrl: e.linkedinUrl,
    name: e.name ?? cap?.fullName ?? null,
    phone: e.phoneNumber ?? null,
    company: e.company ?? cap?.currentCompany ?? null,
    title: e.title ?? cap?.currentTitle ?? null,
    location: cap?.location ?? null,
    // Their whole LinkedIn history, so a job change since the CV still matches (1 Oct).
    employers: (cap?.experience ?? []).map((x) => x.company).filter(Boolean),
    ...captureHistory(cap),
  };

  let found: Omit<CvMatch, "checkedAt" | "decided"> | null = null;
  if (isConvex()) {
    found = await convexQuery<Omit<CvMatch, "checkedAt"> | null>("ta/candidates:findSamePerson", {
      actorId,
      ...Object.fromEntries(Object.entries(profile).filter(([, v]) => (Array.isArray(v) ? v.length : v))),
    }).catch((err) => {
      console.warn(`[cvMatch ${entryId}]`, (err as Error).message);
      return null;
    });
  } else {
    // The local store holds every candidate it knows; the same rules apply.
    for (const c of repo.candidates()) {
      const v = samePerson(profile, {
        fullName: c.fullName,
        linkedinUrl: c.linkedinUrl,
        email: c.email,
        phone: c.phone,
        currentEmployer: c.currentEmployer,
        currentTitle: c.currentTitle,
        location: c.location,
        employers: c.workHistory.map((w) => w.employer),
        jobs: c.workHistory.map((w) => ({ company: w.employer, from: w.fromYear, to: w.toYear })),
        schools: [c.educationInstitution],
      });
      if (v.strength === "none") continue;
      found = { candidateId: c.id, fullName: c.fullName, strength: v.strength, reasons: v.reasons, hasCv: Boolean(c.cvFileName) };
      if (v.strength === "same") break;
    }
  }
  // Checked, and nobody: null, so the row is not looked up again on every visit.
  if (!found) {
    if (e.cvMatch === undefined) repo.updateLink(entryId, { cvMatch: null });
    return null;
  }

  const match: CvMatch = { ...found, checkedAt: Date.now() };
  repo.updateLink(entryId, { cvMatch: match, ...(match.strength === "same" ? { candidateId: match.candidateId } : {}) });
  if (match.strength === "same") await rememberLinkedin(match.candidateId, e.linkedinUrl, actorId);
  return match;
}

/**
 * Rows on an opening never checked — added before matching existed. Looked up
 * a few at a time after a page is shown, so the table fills in without the
 * page waiting. ponytail: rows checked once and found nobody are not asked
 * again; a CV that arrives later for the same person is not linked back.
 * Re-check rows older than a few weeks if that turns out to matter.
 */
export async function matchUnchecked(openingId: Id, actorId?: Id, max = 10): Promise<number> {
  const rows = repo.linkVault(openingId).filter((l) => !l.candidateId && l.cvMatch === undefined).slice(0, max);
  for (const r of rows) await matchLink(r.id, actorId);
  return rows.length;
}

/** A TA's answer to a possible match: the same person, or someone else. */
export async function decideMatch(entryId: Id, decision: "same" | "different", actorId?: Id): Promise<boolean> {
  const e = repo.linkEntry(entryId);
  if (!e?.cvMatch) return false;
  // "Different" also undoes a link the matching made on its own (1 Oct): the
  // row stands alone again, and the LinkedIn address it put on the other
  // person's record comes off, so the mistake is not repeated next time.
  const unlink = decision === "different" && e.candidateId === e.cvMatch.candidateId;
  repo.updateLink(entryId, {
    cvMatch: { ...e.cvMatch, decided: decision },
    candidateId: decision === "same" ? e.cvMatch.candidateId : unlink ? null : e.candidateId,
  });
  if (decision === "same") await rememberLinkedin(e.cvMatch.candidateId, e.linkedinUrl, actorId);
  if (unlink && isConvex() && actorId) {
    await convexMutation("ta/candidates:forgetLinkedin", { actorId, candidateId: e.cvMatch.candidateId, linkedinUrl: e.linkedinUrl }).catch((err) =>
      console.warn(`[cvMatch] taking the LinkedIn address off ${e.cvMatch!.candidateId}:`, (err as Error).message),
    );
  }
  return true;
}

async function rememberLinkedin(candidateId: Id, linkedinUrl: string, actorId?: Id) {
  if (!isConvex() || !actorId) return;
  await convexMutation("ta/candidates:rememberLinkedin", { actorId, candidateId, linkedinUrl }).catch((err) =>
    console.warn(`[cvMatch] remembering the LinkedIn address on ${candidateId}:`, (err as Error).message),
  );
}

/**
 * The extension's LinkedIn jobs with their years, and where they studied (1
 * Oct): with the name, the same company in the same years or the same
 * university makes a match certain. Empty values are left out for the backend.
 */
export function captureHistory(cap: { experience?: { company: string; dates: string | null }[]; education?: { school: string }[] } | null | undefined) {
  const jobs = (cap?.experience ?? [])
    .filter((x) => x.company)
    .map((x) => {
      const y = jobYears(x.dates);
      return { company: x.company, ...(y.from ? { from: y.from } : {}), ...(y.to ? { to: y.to } : {}) };
    });
  const schools = (cap?.education ?? []).map((e) => e.school).filter(Boolean);
  return { ...(jobs.length ? { jobs } : {}), ...(schools.length ? { schools } : {}) };
}

/** One person "Find CV" offers the TA (ta/candidates:searchSamePerson). */
export interface CvHit {
  candidateId: Id;
  fullName: string;
  currentTitle: string | null;
  currentEmployer: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  pastEmployers: string[];
  hasCv: boolean;
  strength: "same" | "possible" | "name";
  score: number;
  reasons: string[];
}

/**
 * "Find CV" (1 Oct): who in our database might be this LinkedIn person, best
 * first, for the TA to choose from. The matching links on its own only when
 * certain; this is for the people it missed — a new company, a changed title.
 */
export async function findCvCandidates(
  profile: { linkedinUrl?: string | null; name?: string | null; email?: string | null; phone?: string | null; company?: string | null; title?: string | null; location?: string | null; employers?: string[]; jobs?: Job[]; schools?: string[] },
  actorId?: Id,
): Promise<CvHit[]> {
  const args = Object.fromEntries(Object.entries(profile).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
  if (isConvex()) return convexQuery<CvHit[]>("ta/candidates:searchSamePerson", { actorId, ...args, limit: 5 });
  const hits: CvHit[] = [];
  for (const c of repo.candidates()) {
    const hit = cvSearchScore(profile, {
      fullName: c.fullName,
      linkedinUrl: c.linkedinUrl,
      email: c.email,
      phone: c.phone,
      currentEmployer: c.currentEmployer,
      currentTitle: c.currentTitle,
      location: c.location,
      employers: c.workHistory.map((w) => w.employer),
      jobs: c.workHistory.map((w) => ({ company: w.employer, from: w.fromYear, to: w.toYear })),
      schools: [c.educationInstitution],
    });
    if (!hit) continue;
    hits.push({
      candidateId: c.id,
      fullName: c.fullName,
      currentTitle: c.currentTitle,
      currentEmployer: c.currentEmployer,
      location: c.location,
      linkedinUrl: c.linkedinUrl,
      email: c.email,
      phone: c.phone,
      pastEmployers: [...new Set(c.workHistory.map((w) => w.employer).filter(Boolean))].slice(0, 4),
      hasCv: Boolean(c.cvFileName),
      ...hit,
    });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, 5);
}

/** The TA chose who this row is: linked, answered, and their LinkedIn address remembered. */
export async function linkRowTo(entryId: Id, hit: Pick<CvHit, "candidateId" | "fullName" | "hasCv">, actorId?: Id) {
  const e = repo.linkEntry(entryId);
  if (!e) return false;
  repo.updateLink(entryId, {
    candidateId: hit.candidateId,
    cvMatch: { candidateId: hit.candidateId, fullName: hit.fullName, strength: "same", reasons: ["Chosen by a TA (Find CV)"], hasCv: hit.hasCv, checkedAt: Date.now(), decided: "same" },
  });
  await rememberLinkedin(hit.candidateId, e.linkedinUrl, actorId);
  return true;
}
