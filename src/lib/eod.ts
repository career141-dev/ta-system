import { repo, setsForOpening } from "@/data/store";
import { EFFORT_NUMBERS, OUTREACH_TYPES } from "@/lib/eod-format";
import { colomboDayStart } from "@/lib/calendar";
import { cvSource, headhuntedCandidates } from "@/lib/cvSource";
import type { Application, Candidate, Id, User } from "@/data/types";
import type { EffortRow, ShortlistRow } from "./eod-format";
import { isEodCandidateEligible, type EodEligibility } from "./eodEligibility";
import { inWorkLocation } from "./workLocations";
import { workdayDate } from "./workday";

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
  // The CV box carries every TA note; the email must not drop later notes
  // after the experience and employer lines take up the first two slots.
  return out;
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
  eligibility?: Pick<EodEligibility, "workType" | "sessionStart" | "day">,
  workLocationId?: string,
): ShortlistRow[] {
  // Who is waiting to be sent: people at the stage BEFORE this reviewer's
  // decision, and not already in a set that went to them. The list used to
  // include people the reviewer had already shortlisted, so a second send
  // put decided candidates back in front of them (audit finding 27).
  const stage = kind === "director" ? "director_review" : "director_shortlist";
  const alreadySent = new Set(
    repo.reviewRounds(openingId).filter((r) => r.kind === kind && !r.recoveryReopenedAt).flatMap((r) => r.applicationIds),
  );
  // Only people actually in Director Review go in the Director's email (29 Sep).
  // A finished follow-up used to pull a TA Shortlisted candidate in as well
  // (25 Sep, PR #56); the desk wants the email to match the stage, so the TA
  // moves them to Director Review first.
  const apps = repo
    .applications(openingId)
    .filter(a => inWorkLocation(a, workLocationId))
    .filter((a) => {
      if (alreadySent.has(a.id)) return false;
      if (kind !== "director" || !eligibility) return a.stage === stage;
      return isEodCandidateEligible(
        {
          stage: a.stage,
          ownerTaId: a.ownerTaId,
          isAddOn: a.isAddOn,
          lastStageChangedAt: a.lastStageChangedAt,
        },
        // Today's email carries today's candidates; older unsent days are a missed end of day.
        { taId, day: workdayDate(Date.now()), ...eligibility },
      );
    })
    // The client's copy is the Director's decision, not the TA's, so it is not
    // narrowed to one recruiter's own shortlisting.
    .filter((a) => (taId && kind === "director" ? a.ownerTaId === taId : true))
    .sort((a, b) => (a.setNumber ?? 0) - (b.setNumber ?? 0));

  return apps.flatMap((a, i) => {
    const c = repo.candidate(a.candidateId);
    return c ? [shortlistRowFor(a, c, i + 1)] : [];
  });
}

/** One person's line in table 1, from their record. */
export function shortlistRowFor(a: Application, c: Candidate, no: number): ShortlistRow {
  return {
    no,
    name: c.fullName,
    age: c.age ? String(c.age) : "",
    // Zero days is "immediate", which is the best answer there is — it was
    // printed as a blank (audit finding 28).
    // As said first ("2 months", "Not disclosed"), which has no days.
    notice:
      c.noticePeriod?.trim() ||
      (c.noticePeriodDays === 0 ? "Immediate" : c.noticePeriodDays ? `${c.noticePeriodDays} days` : ""),
    notes: HOUSE_NOTE(c, a),
    currentCompany: c.currentEmployer ?? "",
    currentDesignation: c.currentTitle ?? "",
    currentRemuneration: c.currentSalary ?? "Not disclosed",
    expectedRemuneration: c.expectedSalary ?? "Open to discuss",
    applicationId: a.id,
    reviewStageChangedAt: a.lastStageChangedAt,
  };
}

/**
 * Table 1 for exactly these people, in this order, whatever their stage —
 * for an email already sent, whose people `shortlistRows` no longer lists
 * because they are in a round (the resend, 8 Oct).
 */
export function rowsForApplications(ids: Id[]): ShortlistRow[] {
  return ids.flatMap((id, i) => {
    const a = repo.application(id);
    const c = a ? repo.candidate(a.candidateId) : null;
    return a && c ? [shortlistRowFor(a, c, i + 1)] : [];
  });
}

/** The column a CV is counted in on the end-of-day sheet. */
export type EffortBucket = "backUp" | "addOns" | "scoop" | "da" | "post" | "l";

/**
 * The one column a CV of the day goes in (the desk, 28 Sep), so the columns
 * add up to the day's total: a backup first, then a scoop mailed in by a lead,
 * then an add-on, then where it came from (lib/cvSource). A scoop stays a
 * scoop on an Add-on day — the desk counts what the leads sent under SCOOP. A
 * database pick is TBR, not a hunted CV, and is in none of them.
 */
export function effortBucket(app: Application, headhunted: ReadonlySet<Id>): EffortBucket | null {
  if (app.backupForApplicationId) return "backUp";
  if (app.scoopFrom || app.scoopReceivedAt) return "scoop";
  if (app.isAddOn) return "addOns";
  const source = cvSource(app, headhunted);
  return source === "database" ? null : source;
}

/**
 * The CVs this TA sends the Director today — the only ones the end-of-day
 * sheet counts (the desk, 28 Sep). A lead mails six, one goes to the
 * Director: that is 1, not 6; ten add-ons worked, three sent: 3.
 *
 * The rounds this TA already sent today, plus the people waiting in tonight's
 * email, once each: so the sheet reads the same before Send (sendEod builds
 * it before the round is opened) and after. The rounds, not the stage: a
 * stage's time is overwritten by the next move, and Excel Tables' "Add to
 * pipeline" puts people in Director Review without sending anything.
 */
export function sentToDirectorToday(openingId: Id, taId: Id, since: number, workLocationId?: string): Application[] {
  const ids = new Set(
    repo
      .reviewRounds(openingId)
      .filter((r) => r.kind === "director" && r.sentBy === taId && r.sentAt >= since && !r.recoveryReopenedAt)
      .flatMap((r) => r.applicationIds),
  );
  for (const r of shortlistRows(openingId, taId, "director", { workType: "100%" }, workLocationId)) ids.add(r.applicationId);
  return [...ids].flatMap((id) => {
    const a = repo.application(id);
    return a && a.openingId === openingId && inWorkLocation(a, workLocationId) ? [a] : [];
  });
}

/**
 * Table 2 — the L-sheet line for today. All of it comes from the records (the
 * desk, 28 Sep); the TA can correct any figure before sending.
 *
 *   L EFFORT  LinkedIn profiles this TA scouted today: every Excel Tables row
 *             added today, contacted or not, and older rows approached or
 *             moved today. On a Follow-up day the column is the CVs sent to
 *             the Director instead (effortColumns).
 *   SETS      the set this TA's latest CV went into (convex/lib/sets.ts).
 *
 * Then the CVs sent to the Director today (sentToDirectorToday) — never
 * everyone who applied or was mailed in, only who was shortlisted — each in
 * exactly one column (effortBucket), so they add up to the total beside SETS:
 *
 *   BACK-UP   tagged as cover for someone already at interview or offer.
 *   SCOOP     uploaded by the TA under Scoops (sent by the Director, a TA Lead or Ops)
 *             (convex/mailIntake); the TA adds WhatsApp ones on top.
 *   ADD-ONS   flagged Add-on — worked on an Add-on day, or tagged by hand.
 *   DA        came to us directly — WhatsApp or a WhatsApp campaign.
 *   POST      applied through a LinkedIn post. It counted adverts put live
 *             until the desk asked for the CVs they brought (28 Sep).
 *   L         headhunted through Excel Tables.
 */
export function effortRow(openingId: Id, ta: User, date = new Date(), workLocationId?: string, onlyIds?: Id[]): EffortRow {
  // Today in Colombo, whatever the server's clock is set to.
  const since = colomboDayStart(date.getTime());
  // A missed day counts that day only, and exactly the people in its email.
  const until = onlyIds ? since + 86400000 : Infinity;
  const vault = repo.linkVault(openingId).filter(r => inWorkLocation(r, workLocationId));
  const day = onlyIds
    ? onlyIds.flatMap((id) => repo.application(id) ?? [])
    : sentToDirectorToday(openingId, ta.id, since, workLocationId);
  const scouted = vault.filter(
    (v) =>
      (v.addedBy === ta.id && v.createdAt >= since && v.createdAt < until) ||
      (v.addedBy === ta.id && (v.outcomeAt ?? 0) >= since && (v.outcomeAt ?? 0) < until) ||
      v.conversationLog.some((l) => l.by === ta.id && l.at >= since && l.at < until),
  ).length;
  const headhunted = headhuntedCandidates(vault);
  const count: Record<EffortBucket, number> = { backUp: 0, addOns: 0, scoop: 0, da: 0, post: 0, l: 0 };
  for (const a of day) {
    const b = effortBucket(a, headhunted);
    if (b) count[b]++;
  }
  const kind = repo.workingStage(openingId, ta.id);
  // The set this TA's latest CV went into.
  const mySets = setsForOpening(openingId, ta.id);
  const latest = mySets.length ? Math.max(...mySets.map((s) => s.setNumber)) : null;

  return {
    date: date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" }),
    assignee: ta.name,
    // The TA's working stage for this opening (100% / Follow-up / Add-on),
    // set manually in the sticky bar or defaulting to "100%".
    hundredOrFollowUp: kind,
    lEffort: kind === "Follow-up" ? day.length : scouted,
    sets: latest,
    da: count.da,
    scoop: count.scoop || null,
    l: count.l,
    post: count.post,
    addOns: count.addOns || null,
    backUp: count.backUp || null,
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
  if (formData.has("effort_date")) {
    const d = String(formData.get("effort_date") ?? "").trim();
    if (d) out.date = d;
  }
  if (formData.has("effort_assignee")) {
    const a = String(formData.get("effort_assignee") ?? "").trim();
    if (a) out.assignee = a;
  }
  const kind = String(formData.get("effort_kind") ?? "");
  if ((OUTREACH_TYPES as readonly string[]).includes(kind)) out.hundredOrFollowUp = kind;
  for (const k of EFFORT_NUMBERS) {
    if (k === "sets") {
      if (formData.has("effort_sets")) {
        const raw = String(formData.get("effort_sets") ?? "").trim();
        if (raw) out.sets = raw;
      }
      if (formData.has("target_sets")) {
        const raw = String(formData.get("target_sets") ?? "").trim();
        if (raw) out.targets!.sets = raw;
      }
      continue;
    }
    const v = num(`effort_${k}`);
    if (v !== undefined) (out as unknown as Record<string, number | null>)[k] = v;
    const t = num(`target_${k}`);
    if (t !== undefined && t !== null) out.targets![k] = t;
  }
  return out;
}

/**
 * Shortlist rows as edited by the TA in the composer: name, age, notice, notes, company, designation, remuneration.
 */
export function shortlistRowsFromForm(
  formData: FormData,
  baseRows: ShortlistRow[],
): ShortlistRow[] {
  return baseRows.map((r, i) => {
    const id = r.applicationId;
    const name = formData.has(`shortlist_${id}_name`) ? String(formData.get(`shortlist_${id}_name`)).trim() : r.name;
    const age = formData.has(`shortlist_${id}_age`) ? String(formData.get(`shortlist_${id}_age`)).trim() : r.age;
    const notice = formData.has(`shortlist_${id}_notice`) ? String(formData.get(`shortlist_${id}_notice`)).trim() : r.notice;
    const notesRaw = formData.has(`shortlist_${id}_notes`) ? String(formData.get(`shortlist_${id}_notes`)) : r.notes.join("\n");
    const notes = notesRaw.split("\n").map((n) => n.trim()).filter(Boolean);
    const currentCompany = formData.has(`shortlist_${id}_currentCompany`) ? String(formData.get(`shortlist_${id}_currentCompany`)).trim() : r.currentCompany;
    const currentDesignation = formData.has(`shortlist_${id}_currentDesignation`) ? String(formData.get(`shortlist_${id}_currentDesignation`)).trim() : r.currentDesignation;
    const currentRemuneration = formData.has(`shortlist_${id}_currentRemuneration`) ? String(formData.get(`shortlist_${id}_currentRemuneration`)).trim() : r.currentRemuneration;
    const expectedRemuneration = formData.has(`shortlist_${id}_expectedRemuneration`) ? String(formData.get(`shortlist_${id}_expectedRemuneration`)).trim() : r.expectedRemuneration;

    return {
      no: i + 1,
      name: name || r.name,
      age: age !== undefined ? age : r.age,
      notice: notice !== undefined ? notice : r.notice,
      notes: notes.length ? notes : r.notes,
      currentCompany: currentCompany !== undefined ? currentCompany : r.currentCompany,
      currentDesignation: currentDesignation !== undefined ? currentDesignation : r.currentDesignation,
      currentRemuneration: currentRemuneration !== undefined ? currentRemuneration : r.currentRemuneration,
      expectedRemuneration: expectedRemuneration !== undefined ? expectedRemuneration : r.expectedRemuneration,
      applicationId: id,
    };
  });
}

// Moved to eod-format (29 Sep) so the composer can use it in the browser too.
export { eodDetailChanges } from "./eod-format";

/**
 * "SET 1 - DELMO - BRAND MANAGER - 3 CVs". The client stays in it: a reply is
 * matched by its subject, and two clients hiring the same title are told
 * apart by the client's name (lib/routing matchReviewReply).
 */
export function subjectLine(clientName: string, title: string, setNumber: number | null = 1, cvCount = 1): string {
  const setPart = `SET ${setNumber ?? 1}`;
  const clientPart = (clientName || "CLIENT").trim().toUpperCase();
  const posPart = title.trim().toUpperCase();
  const cvPart = `${cvCount} ${cvCount === 1 ? "CV" : "CVs"}`;
  return `${setPart} - ${clientPart} - ${posPart} - ${cvPart}`;
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
