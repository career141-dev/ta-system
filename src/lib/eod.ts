import { repo, setsForOpening } from "@/data/store";
import { EFFORT_NUMBERS, OUTREACH_TYPES } from "@/lib/eod-format";
import { colomboDayStart } from "@/lib/calendar";
import type { Application, Candidate, Id, User } from "@/data/types";
import type { EffortRow, ShortlistRow } from "./eod-format";

/**
 * The end-of-day email — spec §10.
 *
 * Two tables, in the order and with the column names the desk already sends,
 * read off the two email screenshots. From the TA's own mailbox, to the
 * Director, copying the TA Lead. Generated for review, never auto-sent.
 */

export type { ShortlistRow, EffortRow } from "./eod-format";
export { SHORTLIST_COLUMNS, EFFORT_COLUMNS, MANUAL_EFFORT } from "./eod-format";

const HOUSE_NOTE = (c: Candidate, a: Application): string[] => {
  const out: string[] = [];
  if (c.totalExperienceYears) out.push(`>Total Experience - ${c.totalExperienceYears}yr`);
  if (c.currentEmployer) out.push(`>Currently at ${c.currentEmployer}`);
  for (const n of a.notes) {
    const clean = n.replace(/^>/, "").trim();
    if (clean && !out.some((o) => o.endsWith(clean))) out.push(`>${clean}`);
  }
  return out.slice(0, 4);
};

/**
 * Table 1 — the people this email is about.
 *
 * The Director's copy is everyone the TA has put up for review; the client's is
 * everyone the Director has already passed. Same table, same columns, one stage
 * apart — which is why it is one function and one screen rather than two.
 */
export function shortlistRows(
  openingId: Id,
  taId: Id | null,
  kind: "director" | "client" = "director",
): ShortlistRow[] {
  // Who is waiting to be sent: people at the stage BEFORE this reviewer's
  // decision, and not already in a set that went to them. The list used to
  // include people the reviewer had already shortlisted, so a second send
  // put decided candidates back in front of them (audit finding 27).
  const stage = kind === "director" ? "director_review" : "director_shortlist";
  const alreadySent = new Set(
    repo.reviewRounds(openingId).filter((r) => r.kind === kind).flatMap((r) => r.applicationIds),
  );
  // For the Director, a candidate whose follow-up is finished is ready too:
  // every question answered is what "ready for the Director" means, and making
  // the TA move each one by hand first is a step the desk does not have.
  // (Kept on 25 Sep by the owner's decision, reviewing PR #56.)
  const readyFromFollowUp =
    kind === "director"
      ? new Set(
          repo
            .followUps()
            .filter((f) => f.application.openingId === openingId && f.followUp.state === "complete")
            .map((f) => f.application.id),
        )
      : new Set<string>();
  const apps = repo
    .applications(openingId)
    .filter((a) => (a.stage === stage || readyFromFollowUp.has(a.id)) && !alreadySent.has(a.id))
    // The client's copy is the Director's decision, not the TA's, so it is not
    // narrowed to one recruiter's own shortlisting.
    .filter((a) => (taId && kind === "director" ? a.ownerTaId === taId : true))
    .sort((a, b) => (a.setNumber ?? 0) - (b.setNumber ?? 0));

  return apps.flatMap((a, i) => {
    const c = repo.candidate(a.candidateId);
    if (!c) return [];
    return [
      {
        no: i + 1,
        name: c.fullName,
        age: c.age ? String(c.age) : "",
        // Zero days is "immediate", which is the best answer there is — it was
        // printed as a blank (audit finding 28).
        notice:
          c.noticePeriodDays === 0 ? "Immediate" : c.noticePeriodDays ? `${c.noticePeriodDays} days` : "",
        notes: HOUSE_NOTE(c, a),
        currentCompany: c.currentEmployer ?? "",
        currentDesignation: c.currentTitle ?? "",
        currentRemuneration: c.currentSalary ?? "Not disclosed",
        expectedRemuneration: c.expectedSalary ?? "Open to discuss",
        applicationId: a.id,
      },
    ];
  });
}

/**
 * Table 2 — the L-sheet line for today. Everything but BACK-UP comes from the
 * records (the desk, 28 Sep); the TA can correct any figure before sending.
 *
 *   L EFFORT  LinkedIn profiles this TA worked today in Excel Tables — added
 *             and contacted, an approach logged, or the outcome moved. On a
 *             Follow-up day the column is CVs instead (effortColumns).
 *   SETS      the set this TA's latest CV went into (convex/lib/sets.ts).
 *   DA        direct applicants this TA shortlisted today.
 *   SCOOP     scoops mailed to the TA by the Director, a TA Lead or Ops
 *             (convex/mailIntake); the TA adds WhatsApp ones on top.
 *   L         headhunted people this TA shortlisted today — Excel Tables rows
 *             set to Shortlisted become L applications.
 *   POST      adverts for this job this TA put live today.
 *   ADD-ONS   CVs this TA flagged Add-on today.
 *   BACK-UP   typed, for now.
 *
 * Database CVs are TBR, not scoops. From 25 to 28 Sep most of these were
 * typed; the desk asked for them back once Excel Tables carried the work.
 */
export function effortRow(openingId: Id, ta: User, date = new Date()): EffortRow {
  // Today in Colombo, whatever the server's clock is set to.
  const since = colomboDayStart(date.getTime());
  const apps = repo.applications(openingId);
  const mine = apps.filter((a) => a.ownerTaId === ta.id);
  const todays = mine.filter((a) => (a.shortlistedAt ?? 0) >= since);
  const mailed = mine.filter((a) => (a.scoopReceivedAt ?? 0) >= since);
  const flagged = mine.filter((a) => a.isAddOn && (a.addedOnAt ?? 0) >= since);
  const worked = repo.linkVault(openingId).filter(
    (v) =>
      (v.addedBy === ta.id && v.createdAt >= since && v.outcome !== "no_contact") ||
      (v.addedBy === ta.id && (v.outcomeAt ?? 0) >= since) ||
      v.conversationLog.some((l) => l.by === ta.id && l.at >= since),
  ).length;
  const kind = repo.workingStage(openingId, ta.id);
  // The set this TA's latest CV went into.
  const mySets = setsForOpening(openingId, ta.id);
  const latest = mySets.length ? Math.max(...mySets.map((s) => s.setNumber)) : null;
  const distinct = new Set([...todays, ...mailed, ...flagged].map((a) => a.id)).size;

  return {
    date: date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" }),
    assignee: ta.name,
    // The TA's working stage for this opening (100% / Follow-up / Add-on),
    // set manually in the sticky bar or defaulting to "100%".
    hundredOrFollowUp: kind,
    lEffort: kind === "Follow-up" ? todays.length : worked,
    sets: latest,
    da: todays.filter((a) => a.sourcingChannel === "DA").length,
    scoop: mailed.length || null,
    l: todays.filter((a) => a.sourcingChannel === "L").length,
    post: repo.jobPosts(openingId).filter((p) => (p.postedAt ?? 0) >= since && (!p.assignedTaId || p.assignedTaId === ta.id)).length,
    addOns: flagged.length || null,
    backUp: null,
    recorded: { cvs: distinct, scoop: mailed.length },
  };
}

/**
 * The L-sheet as the TA left it in the composer: every count and target they
 * typed, over the figures the records give. Anything unreadable keeps the
 * record's figure.
 */
export function effortFromForm(formData: FormData, base: EffortRow): EffortRow {
  const num = (name: string): number | null | undefined => {
    if (!formData.has(name)) return undefined;
    const raw = String(formData.get(name) ?? "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  };
  const out: EffortRow = { ...base, targets: {} };
  const kind = String(formData.get("effort_kind") ?? "");
  if ((OUTREACH_TYPES as readonly string[]).includes(kind)) out.hundredOrFollowUp = kind;
  for (const k of EFFORT_NUMBERS) {
    const v = num(`effort_${k}`);
    if (v !== undefined) (out as unknown as Record<string, number | null>)[k] = v;
    const t = num(`target_${k}`);
    if (t !== undefined && t !== null) out.targets![k] = t;
  }
  return out;
}

/**
 * "DELMO - BRAND MANAGER - SET 2 - 3 CVs". The client stays in it: a reply is
 * matched by its subject, and two clients hiring the same title are told
 * apart by the client's name (lib/routing matchReviewReply).
 */
export function subjectLine(clientName: string, title: string, setNumber: number | null = 1, cvCount = 1): string {
  const setPart = `SET ${setNumber ?? 1}`;
  const cvPart = `${cvCount} ${cvCount === 1 ? "CV" : "CVs"}`;
  return `${clientName.toUpperCase()} - ${title.toUpperCase()} - ${setPart} - ${cvPart}`;
}

/**
 * Deliberately NOT a place to add instructions for the reader.
 *
 * An earlier version appended "kindly reply with the numbers" to make the reply
 * easier to parse. That is the system asking the Director to change how he
 * works so the software has an easier time, which is backwards: this email has
 * been going out in this shape for years and the people reading it are the
 * client and the Director. Whatever comes back, in whatever form, is what has
 * to be read — and where it cannot be read, the fallback is to chase the TA,
 * not to retrain the Director. See lib/sla.
 */
