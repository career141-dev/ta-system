import { repo, setsForOpening } from "@/data/store";
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

  return {
    date: date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Colombo" }),
    assignee: ta.name,
    // There is no day plan recorded yet, so this is left blank rather than
    // printing "FOLLOW UP" for every day regardless (audit finding 28).
    hundredOrFollowUp: "",
    // Profiles approached today, not everything ever approached.
    lEffort: vault.filter((v) => v.addedBy === ta.id && v.outcome !== "no_contact" && v.createdAt >= since).length,
    sets: tonight,
    da: todays.filter((a) => a.sourcingChannel === "DA").length,
    scoop: todays.filter((a) => a.sourcingChannel === "SCOOP").length,
    l: todays.filter((a) => a.sourcingChannel === "L").length,
    // Q4a — undefined, so not reported rather than reported as zero.
    post: null,
    addOns: null,
    backUp: null,
  };
}

export function subjectLine(clientName: string, title: string, date = new Date()): string {
  return `${clientName.toUpperCase()} - ${title.toUpperCase()} - ${date
    .toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    .toUpperCase()}`;
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
