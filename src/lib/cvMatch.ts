import "server-only";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import type { CvMatch, Id } from "@/data/types";
import { convexMutation, convexQuery } from "@/lib/convexServer";
import { samePerson } from "../../convex/lib/samePerson";

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
  };

  let found: Omit<CvMatch, "checkedAt" | "decided"> | null = null;
  if (isConvex()) {
    found = await convexQuery<Omit<CvMatch, "checkedAt"> | null>("ta/candidates:findSamePerson", {
      actorId,
      ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v)),
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
  repo.updateLink(entryId, {
    cvMatch: { ...e.cvMatch, decided: decision },
    candidateId: decision === "same" ? e.cvMatch.candidateId : e.candidateId,
  });
  if (decision === "same") await rememberLinkedin(e.cvMatch.candidateId, e.linkedinUrl, actorId);
  return true;
}

async function rememberLinkedin(candidateId: Id, linkedinUrl: string, actorId?: Id) {
  if (!isConvex() || !actorId) return;
  await convexMutation("ta/candidates:rememberLinkedin", { actorId, candidateId, linkedinUrl }).catch((err) =>
    console.warn(`[cvMatch] remembering the LinkedIn address on ${candidateId}:`, (err as Error).message),
  );
}
