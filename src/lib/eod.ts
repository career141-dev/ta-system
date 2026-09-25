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
export { SHORTLIST_COLUMNS, EFFORT_COLUMNS, UNDEFINED_COLUMNS } from "./eod-format";

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

/** Table 2 — the L-sheet line for today. Every figure is today's. */
export function effortRow(openingId: Id, ta: User, date = new Date()): EffortRow {
  const apps = repo.applications(openingId);
  const vault = repo.linkVault(openingId);
  // Today in Colombo, whatever the server's clock is set to.
  const since = colomboDayStart(date.getTime());

  const mine = apps.filter((a) => a.ownerTaId === ta.id);
  const todays = mine.filter((a) => (a.shortlistedAt ?? 0) >= since);
  // The set going out tonight — this TA's newest.
  const mySets = setsForOpening(openingId, ta.id);
  const tonight = mySets.length ? Math.max(...mySets.map((s) => s.setNumber)) : null;

  const approached = vault.filter((v) => v.addedBy === ta.id && v.outcome !== "no_contact" && v.createdAt >= since).length;
  const addOns = mine.filter((a) => a.isAddOn && (a.addedOnAt ?? 0) >= since).length;
  // The TA's working stage for this opening (100% / Follow-up / Add-on),
  // set manually in the sticky bar or defaulting to "100%".
  const kind = repo.workingStage(openingId, ta.id);

  return {
    date: date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" }),
    assignee: ta.name,
    hundredOrFollowUp: kind,
    // Profiles approached today on a hunt; on a follow-up day, CVs brought in.
    lEffort: kind === "Follow-up" ? todays.length : approached,
    sets: tonight,
    da: todays.filter((a) => a.sourcingChannel === "DA").length,
    // Database picks shortlisted today, plus scoops: CVs this TA brought in on
    // someone else's candidate today (plan 6.4).
    scoop:
      todays.filter((a) => a.sourcingChannel === "SCOOP").length +
      apps.filter((a) => a.scoopBy === ta.id && (a.scoopAt ?? 0) >= since).length,
    l: todays.filter((a) => a.sourcingChannel === "L").length,
    // Counted now, not left blank (21 Sep): adverts this TA put live today,
    // add-ons marked today, and backups lined up today.
    post: repo.jobPosts(openingId).filter((p) => (p.postedAt ?? 0) >= since && (!p.assignedTaId || p.assignedTaId === ta.id)).length,
    addOns,
    backUp: mine.filter((a) => a.backupForApplicationId && a.createdAt >= since).length,
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
