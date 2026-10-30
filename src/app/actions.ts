"use server";

import { revalidatePath } from "next/cache";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { allows, can, isDeskWide, isReadOnly, isTa, seesEveryTaRow, type Capability } from "@/lib/auth";
import { otherHolders, rowCountsFor } from "@/lib/sharedLinks";
import { readWorkCountry } from "@/lib/countries";
import { BIN_DAYS, BIN_MS, purgeDateLabel } from "@/lib/bin";
import {
  binOpeningNamed as binOpeningShared,
  binOpenings,
  decideOn,
  writeOpeningStatus,
  writeWorkingStage,
  type OpeningStatusValue,
  type OpeningWriteDeps,
} from "@/lib/openings/writes";
import { decideAccess, requestAccess, writeOpeningDetails, writeOpeningTeam } from "@/lib/openings/admin";
import {
  amendJdText as amendJdShared,
  approveJdText as approveJdShared,
  generateJd as generateJdShared,
  reextractJdDetails as reextractJdDetailsShared,
  restoreJd as restoreJdShared,
  reviseJd as reviseJdShared,
  saveJdDetails as saveJdDetailsShared,
  writeJdNotes,
} from "@/lib/openings/jdWrites";
import { movePipelineCandidate } from "@/lib/openings/pipelineWrites";
import { acceptStrategies, removeStrategyPicture, strategyBellDue, submitStrategies } from "@/lib/openings/strategyWrites";
import { writeCandidateProfile } from "@/lib/candidates/profileWrites";
import { writeCandidateInterview } from "@/lib/candidates/interviewWrites";
import { writeCandidateClosing } from "@/lib/candidates/closingWrites";
import { writeCandidateReview } from "@/lib/candidates/reviewWrites";
import { writeCandidateCall } from "@/lib/candidates/callWrites";
import { checkCandidateReferee } from "@/lib/candidates/referenceChecks";
import { sendCandidateFollowUp, setCandidateConversationOwner, stopCandidateFollowUp } from "@/lib/candidates/followUpWrites";
import { rematchWhenRequirementsSettle as rematchShared, startMatching } from "@/lib/openings/matching";
import { headers } from "next/headers";
import type { CvMatch, EodEmailCopy, FollowUpCallOutcome, RefereeCall, RefereeCallEmailRow, User, WorkingStage } from "@/data/types";
import type { CallKind, CallOutcome, ExtractedBrief, PriorityTier, Stage } from "@/data/types";
import type { FeedbackCategory, FeedbackPriority, FeedbackStatus, FeedbackItem } from "@/data/types";
import { ASSIGNMENT_LABEL, STAGE_LABEL } from "@/data/types";
import { BACK_TO_TABLES_REASON, movedBackToTables, awaitingShortlist } from "@/lib/pipeline";
import { BULK_STAGES } from "@/lib/bulkStages";
import { linkedinPostUrl } from "@/lib/workdayRequirements";
import { extractFromText, EMPTY_EXTRACT } from "@/lib/intake";
import { redirect as nextRedirect } from "next/navigation";
import { invalidateCandidate, markTablesStale, resetStore, withRealIds } from "@/data/primeState";
import { contextFor } from "@/lib/openings/jdDraft";
import { saveNewClient as sharedSaveNewClient, saveNewOpening as sharedSaveNewOpening } from "@/lib/openings/create";
import { answer, inline, isInline, type ActionResult } from "@/lib/inlineResult";
import type { EffortRow, ShortlistRow } from "@/lib/eod-format";
import type { DailyEmail, DailyEmailSnapshot, SubmissionType } from "@/lib/dailyEmail";
import { EOD_TO, checkResearchSubmission, eodRecipients, parseAddressList } from "@/lib/eod-format";
import { parseReferenceProfile, referenceProfileFromBlueprint, serializeReferenceProfile } from "@/lib/referenceSearchProfile";
import { referenceCvFileProblem } from "@/lib/referenceCvFile";
import { isEodCandidateEligible } from "@/lib/eodEligibility";
import { makeReviewToken } from "@/lib/reviewToken";
import { masterSheetStatusFields, type MasterSheetPositionStatus } from "@/lib/masterSheet";
import { BOX } from "@/lib/career141Box";
import { validateWorkLocations, requireWorkLocation, inWorkLocation } from "@/lib/workLocations";
import { safeErrorMessage } from "@/lib/userError";

/** A direct Convex write, after which the loaded tables are re-read (primeState.markTablesStale). */
function freshAfter<A extends unknown[], R>(write: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    const result = await write(...args);
    markTablesStale();
    return result;
  };
}

/** Redirect, with any id created in this action swapped for the one the database gave it. */
function redirect(url: string): never {
  return nextRedirect(withRealIds(url)) as never;
}
import { after } from "next/server";
import { FAILURE_MESSAGE, gemini, modelFor } from "@/lib/ai";
import { DEFAULT_DEPS as WEB, researchViaSearch } from "@/lib/researchSearch";
import { SENIORITY_LABEL, benchmarkByDefault, findIncumbents, seniorityOf, type IncumbentRow } from "@/lib/incumbents";
import { MAX_ROUNDS, runSourcing } from "@/lib/sourcing";
import { canonicalProfile, displayUrl, searchProvider, serperConfigured } from "@/lib/serper";
import { linkKey, profileLink } from "@/lib/url";
import { parseLinkPaste } from "@/lib/linkPaste";
import { captureHistory, decideMatch, findCvCandidates, linkRowTo, matchLink, type CvHit } from "@/lib/cvMatch";
import { splitSkills } from "../../convex/lib/jobRequirements";
import { draftsFor } from "@/lib/followup";
import { colomboDayFromValue, colomboDayStart, colomboLocalToInstant } from "@/lib/calendar";
import { isTicked } from "@/lib/strategyPlanner";
import { dateAt } from "@/lib/format";
import { findDatabaseMatches } from "@/lib/dbMatch";
import { markMatching } from "@/lib/matchingNow";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { convexAction, convexActorForEmail, convexMutation, convexQuery, internalUploadUrl } from "@/lib/convexServer";
import * as backend from "@/data/convex/backend";

/** Keep the website's responsive 30-second assignment-bell debounce. */
function bellDue(key: string, ms = 30_000): boolean {
  return strategyBellDue(key, ms);
}

// ─── Authorization ───────────────────────────────────────────────────────────

/**
 * Go back to the page the form was on, carrying a message.
 *
 * A refused write that redirects to a fixed page, or to one that ignores the
 * message, looks like a dead button. Returning to the referring page keeps the
 * person where they were and tells them why.
 */
/** The candidate a form acts on, so the action loads their record before reading it. */
function candidateIdsIn(formData: FormData): string[] {
  const id = String(formData.get("candidateId") ?? "").trim();
  return id ? [id] : [];
}

/**
 * Return to the page with something to say.
 *
 * The tone is carried beside the message so the banner can look like what
 * happened: green for a save that worked, red for one that did not. Every
 * message used to arrive in the same amber box, so "7 shortlisted" and "Only a
 * lead can delete an opening" were indistinguishable at a glance (18
 * September). `back` is the success (green), `fail` the refusal (red), `note`
 * the in-between (amber) — done, but not the way that was asked.
 */
type Tone = "ok" | "error" | "note";

async function back(message: string, tone: Tone = "ok"): Promise<never> {
  // Called through inline(), the message goes back to the form that asked
  // instead of the top of the page (lib/inlineResult, 21 Sep).
  if (isInline()) answer(message, tone === "note" ? "warn" : tone);
  const ref = (await headers()).get("referer");
  let to = "/";
  if (ref) {
    try {
      const u = new URL(ref);
      u.searchParams.set("msg", message);
      u.searchParams.set("tone", tone);
      to = u.pathname + u.search;
    } catch {
      /* an unreadable referer falls back to the dashboard */
    }
  } else {
    to = `/?msg=${encodeURIComponent(message)}&tone=${tone}`;
  }
  redirect(to);
}

/** back(), named for what it says: it worked. */
async function done(message: string): Promise<never> {
  return back(message);
}

/** Back with a refusal: the same message, shown as an error. */
async function fail(message: string): Promise<never> {
  return back(message, "error");
}

/** Back with something that happened, but not as asked (amber). */
async function note(message: string): Promise<never> {
  return back(message, "note");
}

type RefKind = Parameters<typeof repo.openingOf>[0];

/**
 * Which form field names a record this action touches. The record's own
 * opening is what authorization is decided on — never the `openingId` the
 * browser sent alongside it.
 */
type Ref = Partial<Record<RefKind | "opening" | "candidate", string>>;

/**
 * The gate every server action passes through before it writes.
 *
 * It resolves who is asking, what the record really belongs to, what they are
 * on that opening, and whether the collision lock applies — then asks the one
 * policy in `lib/auth`. A refusal goes back to the page with a reason. There is
 * no path where the write happens anyway.
 */
async function authorize(formData: FormData, capability: Capability, ref: Ref = {}): Promise<User> {
  const user = await getCurrentUser();

  const sentOpening = ref.opening ? String(formData.get(ref.opening) ?? "") || null : null;
  let openingId: string | null = sentOpening;
  let ownerTaId: string | null = null;

  for (const [kind, field] of Object.entries(ref) as [keyof Ref, string][]) {
    if (kind === "opening" || kind === "candidate" || !field) continue;
    const id = String(formData.get(field) ?? "");
    if (!id) await fail("Something on this form was missing. Reload the page and try again.");
    const hit = repo.openingOf(kind, id);
    if (!hit.found) await fail("That record no longer exists — it may have been removed.");
    if (sentOpening && hit.openingId && hit.openingId !== sentOpening) {
      await fail("That record belongs to a different opening.");
    }
    openingId = hit.openingId ?? openingId;
    ownerTaId = hit.ownerTaId ?? ownerTaId;
  }

  if (ref.candidate) {
    // Editing a person through an opening needs them to be on it — otherwise
    // any opening you can reach becomes a way to edit anybody in the database.
    const candidateId = String(formData.get(ref.candidate) ?? "");
    const onIt = !!openingId && repo.applications(openingId).some((a) => a.candidateId === candidateId);
    if (!onIt) await fail("That candidate is not on this opening.");
  }

  // The decision itself is shared with the mobile API (lib/openings/writes, 22 Oct).
  const decision = await decideOn(user, capability, { openingId, ownerTaId }, OPENING_DEPS);
  if (!decision.ok) await fail(decision.message);
  return user;
}

export async function moveStage(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("appId"));
  const stage = String(formData.get("stage")) as Stage;
  const openingId = String(formData.get("openingId"));
  const picked = String(formData.get("reason") ?? "");
  const other = String(formData.get("reasonOther") ?? "").trim();
  const reason = picked === "Other" ? other || "Other" : other ? `${picked} — ${other}` : picked;
  if (!appId) await fail("Something on this form was missing. Reload the page and try again.");
  const result = await movePipelineCandidate(user, openingId, appId, stage, reason, OPENING_DEPS);
  if (!result.ok) await fail(result.message);
  await done(result.message);
}

/** A user's name for a message, or a fair stand-in when they are not loaded. */
function userName(id: string): string {
  return repo.users().find((u) => u.id === id)?.name ?? "another recruiter";
}

// ─── Backend writes (Convex store) ───────────────────────────────────────────

/**
 * A rejected or dropped-out application back in Follow-up. The backend clears
 * the old rejection as it moves them (pipelineStateMachine).
 */
async function reinstate(user: User, appId: string, openingId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const userId = user.id;
  // The collision lock holds for a closed application too: somebody else's
  // rejected candidate is theirs to bring back, or a lead's — not a second
  // TA's, who was told "Back on …" in green (review of PR #2, 21 Sep).
  const owner = repo.application(appId)?.ownerTaId ?? null;
  if (owner && owner !== userId && !isDeskWide(user)) {
    const name = repo.users().find((u) => u.id === owner)?.name ?? "another recruiter";
    return { ok: false, message: `${name} owns this candidate here. Ask them or the TA lead to bring them back.` };
  }
  const targetStage: Stage = "ta_follow_up";
  if (isConvex()) {
    // Brought back is taken on (1 Oct): with no owner they were in nobody's
    // sets or end-of-day, and read as not shortlisted. The backend claims them
    // as part of the move (2 Oct).
    let r: Awaited<ReturnType<typeof backend.moveStage>>;
    try {
      r = await backend.moveStage({ id: userId }, appId, targetStage, "Brought back");
    } catch (e) {
      return { ok: false, message: backendMessage(e, "the move was refused.") };
    }
    await afterBackendWrite(openingId);
    if (r?.ownerTaId) return { ok: false, message: `Already shortlisted by ${userName(r.ownerTaId)}.` };
    return { ok: true };
  }
  const r = repo.moveStage(appId, targetStage, userId, "Brought back");
  if (r.ok && !owner) repo.shortlist(appId, userId);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

/** A sourcing or benchmark failure code as a sentence. */
const SEARCH_NAME: Record<string, string> = { claude: "Claude web search", searxng: "SearXNG", serper: "Serper", openai: "OpenAI web search" };

/**
 * Who did a Research run, from what actually answered: "Claude web search ×21,
 * SearXNG ×3 + Claude". Named from the settings, it said DeepSeek even when
 * the subscription had answered (24 Sep).
 */
function answeredByLabel(by: { search: Record<string, number>; model: Record<string, number> }): string {
  const list = (m: Record<string, number>, name: (k: string) => string) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${name(k)} ×${n}`).join(", ");
  const model = (k: string) => (k.startsWith("claude-subscription") ? "Claude" : k);
  return [list(by.search, (k) => SEARCH_NAME[k] ?? k), list(by.model, model)].filter(Boolean).join(" + ");
}

function searchReasonInWords(code: string, detail?: string): string {
  if (code === "no_serper") return "web search is not set up on this system. An admin needs to set SEARXNG_URL (a SearXNG instance) or a search key.";
  // Not the same as finding nothing: the search itself failed. What to do
  // about it depends on who was asked — our own SearXNG has no key to check,
  // and telling the desk to check one sent them looking for something that
  // does not exist (live, 23 Sep).
  if (code === "search_failed") {
    const what = detail ? ` (${detail})` : "";
    return searchProvider() === "searxng"
      ? `the search service could not answer${what}. Nothing is wrong with the client record — an admin needs to look at the search service.`
      : `the search provider refused the request${what}. Check the search key and its credits.`;
  }
  if (code === "rounds_spent") return `all ${MAX_ROUNDS} rounds for this opening are used.`;
  if (code === "no_opening") return "the opening could not be found. Reload the page.";
  // Not a failure: the run that started when the job was created is still going.
  if (code === "running") return "it is already running for this opening — it starts by itself when the job is created. The results appear here when it finishes, usually within a few minutes.";
  // Not a failure: the opening has had its run. Named so nobody hunts for a fault.
  if (code === "run_spent") return `Research has already been run for this opening${detail ? ` ${detail}` : ""}. It runs once per opening — ask a lead if it has to be run again.`;
  if (code === "benchmark_spent") return `Benchmark has already been run for this opening${detail ? ` on ${detail}` : ""}. It runs once per opening — ask a lead if it has to be run again.`;
  if (code === "nothing_found") return "the search found nothing under the client's name. Check the name on the client record.";
  if (code === "client_not_searchable") return "the client has no searchable name (a code or \"Confidential\"). Put the real name on the client record.";
  return reasonInWords(code);
}

/** A model failure code ("spend_cap") as the sentence it stands for. */
function reasonInWords(reason: string | undefined): string {
  const said = reason && (FAILURE_MESSAGE as Record<string, string>)[reason];
  return said ?? (reason ? `${reason}.` : "no reason was given.");
}

/** The backend's own reason, without the transport's wrapping. */
function backendMessage(e: unknown, fallback: string): string {
  return safeErrorMessage(e, fallback);
}

/** What the shared opening writes (lib/openings/writes) need from this app. */
const OPENING_DEPS: OpeningWriteDeps = {
  revalidatePath,
  convexQuery,
  convexMutation,
  markTablesStale,
  // The same function @/data/prime re-exports; taken from primeState so it runs synchronously.
  resetStore,
};

const JD_DEPS = { convexQuery, markTablesStale, resetStore };

/** The primed copy is behind a backend write; drop it so the next read is fresh. */
async function afterBackendWrite(openingId: string) {
  const { resetStore } = await import("@/data/prime");
  resetStore();
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function addCandidateToJob(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const openingId = String(formData.get("openingId") ?? "");
  const destinationId = String(formData.get("destinationId") ?? "");
  if (!destinationId) await fail("Choose a job.");
  if (!isConvex()) await fail("Adding to another job requires the backend.");
  let alreadyInFollowUp = false;
  try {
    const result = await backend.addToAssignedJob({ id: user.id }, String(formData.get("appId")), destinationId);
    alreadyInFollowUp = result.alreadyInFollowUp;
  } catch (e) {
    await fail(backendMessage(e, "Could not add the candidate to that job."));
  }
  await afterBackendWrite(openingId);
  revalidatePath(`/openings/${destinationId}`, "layout");
  await back(alreadyInFollowUp ? "This candidate is already in TA Follow-up on that job." : "Added to the other job’s TA Follow-up.");
}

export async function claimCandidate(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  if (isConvex()) {
    let r: Awaited<ReturnType<typeof backend.shortlist>> | null = null;
    try {
      r = await backend.shortlist({ id: user.id }, appId);
    } catch (e) {
      // Read again either way: an error after the claim was written showed
      // them as not shortlisted until the cache ran out (1 Oct).
      await afterBackendWrite(openingId);
      await fail(backendMessage(e, "Could not shortlist."));
    }
    // Named before the store is dropped — reading `repo` after that would throw.
    const owner = r && !r.ok ? repo.users().find((u) => u.id === r.ownerTaId)?.name ?? "another recruiter" : null;
    await afterBackendWrite(openingId);
    if (owner) await fail(`${owner} already claimed this candidate.`);
    // It used to succeed in silence — the row simply moved away, which read
    // as the button having done nothing (21 September).
    await back(`Shortlisted${r?.ok && r.setNumber ? ` as set ${r.setNumber}` : ""} — moved to TA Follow-up.`);
  }
  repo.shortlist(appId, user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
  await back("Shortlisted — moved to TA Follow-up.");
}

/**
 * Send the next follow-up: the approved WhatsApp template and an email the
 * first time, a reminder after that. Through the backend's outreach gate, so
 * in test mode only the test recipient receives it.
 */
export async function sendFollowUpNow(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const raw = String(formData.get("channel") ?? "");
  // The WhatsApp and Email buttons send one channel; the older button sends both.
  const channel = raw === "whatsapp" || raw === "email" ? raw : undefined;
  const result = await sendCandidateFollowUp(user, openingId, appId, channel, OPENING_DEPS);
  if (!result.ok) await (result.notice ? note : fail)(result.message);
  await done(result.message);
}

/** "Take over" / "Hand back to the assistant" on a candidate's follow-up (30 Oct). */
export async function setConversationOwner(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const owner = formData.get("owner") === "ta" ? "ta" : "assistant";
  const result = await setCandidateConversationOwner(user, openingId, appId, owner, OPENING_DEPS);
  if (!result.ok) await fail(result.message);
  await done(result.message);
}

export async function stopFollowUpNow(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const result = await stopCandidateFollowUp(user, openingId, appId, OPENING_DEPS);
  if (!result.ok) await fail(result.message);
  await done(result.message);
}

/**
 * Confirm the pre-shortlisted high scorers, several at once. Each one is
 * checked on its own — a candidate another TA claimed a moment ago is skipped,
 * not taken.
 */
export async function confirmShortlist(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const ids = formData.getAll("appId").map(String);
  if (ids.length === 0) await fail("Tick at least one candidate.");
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  let done = 0;
  let skipped = 0;
  // A failure is said as what it was (1 Oct): every one used to read "already
  // taken by someone else", so an error looked like a colleague's claim.
  let failed = 0;
  let lastError = "";
  for (const id of ids) {
    const app = repo.application(id);
    if (!app || app.openingId !== openingId) { failed++; lastError = "no longer on this opening"; continue; }
    if (!can(user, "opening.act", { openingId, assignment, ownerTaId: app.ownerTaId }).ok) { skipped++; continue; }
    if (isConvex()) {
      try {
        const r = await backend.shortlist({ id: user.id }, id);
        if (r.ok) done++; else skipped++;
      } catch (e) {
        failed++;
        lastError = backendMessage(e, "the claim was refused");
      }
      continue;
    }
    const r = repo.shortlist(id, user.id);
    if (r.ok) done++; else skipped++;
  }
  if (isConvex()) {
    const { resetStore } = await import("@/data/prime");
    resetStore();
  }
  revalidatePath(`/openings/${openingId}`, "layout");
  const message =
    `${done} shortlisted and sent to Follow-up.` +
    (skipped ? ` ${skipped} skipped — already taken by someone else.` : "") +
    (failed ? ` ${failed} could not be shortlisted (${lastError}) — try them again.` : "");
  await (failed && !done ? fail(message) : back(message, failed ? "note" : "ok"));
}

export async function logCall(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const result = await writeCandidateCall(user, openingId, appId, {
    kind: String(formData.get("kind")) as CallKind,
    outcome: String(formData.get("outcome")) as CallOutcome,
    body: String(formData.get("body") ?? ""),
  }, OPENING_DEPS);
  if (!result.ok) await fail(result.message);
  await back(result.message);
}

/** What the match found, as the start of the message after adding a profile. */
function heldLine(m: CvMatch | null): string {
  if (!m) return "";
  if (m.strength === "possible") return `This may be ${m.fullName}, already in the database — confirm on the row. `;
  return `${m.fullName} is already in the database${m.hasCv ? " with a CV" : ""}, and the row is linked to them. `;
}

/**
 * A TA's answer to a possible match on an Excel Tables row (28 Sep): the same
 * person — the row then uses their record and CV — or someone else.
 */
export async function decideCvMatch(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const decision = String(formData.get("decision")) === "same" ? "same" : "different";
  const e = repo.linkEntry(entryId);
  if (!e || e.openingId !== openingId) await fail("That row no longer exists. Reload the page.");
  // Unlinking a row whose person is already on this opening's pipeline would
  // leave that application on the wrong record: it is dealt with there first.
  if (decision === "different" && e!.candidateId) {
    const onPipeline = repo.applicationsForCandidate(e!.candidateId).find((a) => a.openingId === openingId);
    if (onPipeline) {
      await fail(`${e!.cvMatch?.fullName ?? "They"} ${e!.cvMatch?.fullName ? "is" : "are"} already on this opening's pipeline from this row. Reject or drop them there first, then mark this row as a different person.`);
    }
  }
  if (!(await decideMatch(entryId, decision, user.id))) await fail("There is no match on that row to answer.");
  revalidateLinks(openingId);
  await done(
    decision === "same"
      ? `Linked to ${e!.cvMatch!.fullName}'s record.`
      : `Done — not the same person. This row is no longer linked to ${e!.cvMatch!.fullName}.`,
  );
}

export async function addLink(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const typed = String(formData.get("url") ?? "").trim();
  if (!typed) await fail("Paste a LinkedIn profile link first.");
  // Tidied before it is saved: "linkedin.com/in/x", "lk.linkedin.com/in/x/"
  // and "https://www.linkedin.com/in/x?trk=…" are one person (21 Sep).
  const profile = profileLink(typed);
  if (!profile) {
    await fail("That is not a LinkedIn profile link. It should look like linkedin.com/in/their-name.");
  }
  const { url, key, guessedName } = profile!;
  // A note for the TA, typed alongside the link by a lead (25 Sep). Checked
  // before anything is saved, so a refused note does not leave half a row.
  const leadNote = String(formData.get("note") ?? "").trim();
  if (leadNote) await checkLeadNote(user, leadNote);
  // Your own row, or one a lead added for you, is the row (22 Oct). Another
  // TA holding the same person does not stop you: whoever shortlists first
  // works them (lib/sharedLinks).
  const deskWide = deskWideCheck();
  const already = repo.findLinkByUrl(openingId, key, rowCountsFor(user, deskWide));
  if (already) {
    const who = repo.users().find((u) => u.id === already.addedBy)?.name;
    const said = `${already.name ?? "That profile"} is already in this table${who ? `, added by ${who}` : ""}.`;
    if (!leadNote) await note(said);
    // The note was the point of the paste; it goes on the row that is there.
    repo.addLeadNote(already.id, user.id, user.role, leadNote);
    revalidateLinks(openingId);
    await note(`${said} Your note was added to that row.`);
  }
  const name = String(formData.get("name") ?? "").trim() || guessedName;
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  const id = repo.addLink(openingId, url, user.id, name, "shortlisted", location?.id, Number(formData.get("level")) || undefined);
  if (leadNote) repo.addLeadNote(id, user.id, user.role, leadNote);
  // Is this someone we already hold? (lib/cvMatch, 28 Sep.) Asked now, so
  // the row says so the moment it appears.
  const held = await matchLink(id, user.id);
  revalidateLinks(openingId);
  await done(
    heldLine(held) +
    (name
      ? `Saved ${name} to Excel Tables as Shortlisted${String(formData.get("name") ?? "").trim() ? "" : " — the name is read from the link, so check it"}.`
      : "Saved to Excel Tables as Shortlisted. Add their name from the row, so it can go to the pipeline.") +
      (leadNote ? " Your note is on the row." : "") +
      alsoHeldLine(otherHolders(repo.linksByUrl(openingId, key), user, deskWide)),
  );
}

/** Most rows one paste adds: the lot is saved as one transaction. */
const PASTE_MAX = 100;

/**
 * Many rows at once, copied out of the TA's own Excel sheet (26 Oct): each
 * row with a LinkedIn profile is added to the chosen L as Shortlisted, its
 * contact number kept as the phone and the rest of the row as the TA's note
 * (lib/linkPaste). Someone already in the table is left as they are.
 */
export async function addLinksBulk(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const { rows, skipped } = parseLinkPaste(String(formData.get("rows") ?? ""));
  if (!rows.length) await fail("No LinkedIn profile links in what was pasted. Copy the rows from the sheet, link column included.");
  if (rows.length > PASTE_MAX) await fail(`That is ${rows.length} rows. Paste up to ${PASTE_MAX} at a time.`);
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  const level = Number(formData.get("level")) || undefined;
  const deskWide = deskWideCheck();
  let added = 0, there = 0, bad = 0;
  for (const row of rows) {
    const profile = profileLink(row.url);
    if (!profile) { bad++; continue; }
    if (repo.findLinkByUrl(openingId, profile.key, rowCountsFor(user, deskWide))) { there++; continue; }
    const id = repo.addLink(openingId, profile.url, user.id, profile.guessedName, "shortlisted", location?.id, level);
    if (row.phone) repo.updateLink(id, { phoneNumber: row.phone, phoneSource: "other" });
    if (row.note) repo.addLinkTaNote(id, user.id, row.note.slice(0, 1000));
    added++;
  }
  revalidateLinks(openingId);
  await done(
    `Added ${added} to Excel Tables as Shortlisted.` +
      (there ? ` ${there} ${there === 1 ? "was" : "were"} already in the table.` : "") +
      (bad ? ` ${bad} link${bad === 1 ? " was not a profile" : "s were not profiles"}.` : "") +
      (skipped ? ` ${skipped} line${skipped === 1 ? "" : "s"} had no LinkedIn link.` : "") +
      " Names are read from the links, so check them.",
  );
}

/** Whether a user is a lead, director, admin or ops — whose rows every TA sees. */
function deskWideCheck() {
  return (id: string) => { const u = repo.user(id); return !!u && isDeskWide(u); };
}

/** " Thushini also has them in her table — …" when another TA holds the same person. */
function alsoHeldLine(others: string[]): string {
  const names = others.map((id) => repo.user(id)?.name ?? "Another TA");
  if (!names.length) return "";
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return ` ${who} also ${names.length === 1 ? "has" : "have"} them in their table — whoever shortlists them first works them.`;
}

/** Longest note a lead can leave: feedback, not a document. */
const LEAD_NOTE_MAX = 2000;

async function checkLeadNote(user: User, text: string) {
  const may = can(user, "link.note");
  if (!may.ok) await fail(may.message);
  if (text.length > LEAD_NOTE_MAX) {
    await fail(`That note is ${text.length} characters. Keep it under ${LEAD_NOTE_MAX}.`);
  }
}

function revalidateLinks(openingId: string) {
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
}

/**
 * A note for the TA on an Excel Tables row, from a lead, director, admin or
 * ops. The TA reads it on the row as "TA Lead · <name> sent this note".
 */
export async function addLeadNote(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "link.note", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const text = String(formData.get("note") ?? "").trim();
  if (!text) await fail("Write the note first.");
  await checkLeadNote(user, text);
  if (!repo.addLeadNote(entryId, user.id, user.role, text)) {
    await fail("That row no longer exists — it may have been removed.");
  }
  revalidateLinks(openingId);
  await done("Note sent.");
}

export async function removeLeadNote(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "link.note", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const noteId = String(formData.get("noteId") ?? "");
  const row = repo.linkVault(openingId).find((l) => l.id === entryId);
  const target = row?.leadNotes?.find((n) => n.id === noteId);
  if (!target) await fail("That note is already gone.");
  if (target!.by !== user.id) await fail("Only the person who wrote a note can remove it.");
  repo.removeLeadNote(entryId, noteId);
  revalidateLinks(openingId);
  await done("Note removed.");
}

/**
 * A note recorded by the TA on an Excel Tables candidate profile.
 */
export async function addLinkTaNote(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const text = String(formData.get("note") ?? "").trim();
  if (!text) await fail("Write the note first.");
  if (text.length > LEAD_NOTE_MAX) {
    await fail(`That note is ${text.length} characters. Keep it under ${LEAD_NOTE_MAX}.`);
  }
  if (!repo.addLinkTaNote(entryId, user.id, text)) {
    await fail("That row no longer exists — it may have been removed.");
  }
  revalidateLinks(openingId);
  await done("Note saved.");
}

export async function removeLinkTaNote(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const noteId = String(formData.get("noteId") ?? "");
  const row = repo.linkVault(openingId).find((l) => l.id === entryId);
  const target = row?.taNotes?.find((n) => n.id === noteId);
  if (!target) await fail("That note is already gone.");
  if (target!.by !== user.id && !isDeskWide(user)) {
    await fail("Only the author can remove this note.");
  }
  repo.removeLinkTaNote(entryId, noteId);
  revalidateLinks(openingId);
  await done("Note removed.");
}

/**
 * A note on a person in Director review. Anyone on the opening may leave one:
 * the TA, the lead, the director, an admin (29 Sep). The byline shows whose it is.
 */
export async function addReviewNote(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  const appId = String(formData.get("appId"));
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const result = await writeCandidateReview(user, openingId, appId, {
    action: "add_note",
    note: String(formData.get("note") ?? ""),
  }, { ...OPENING_DEPS, invalidateCandidate, primeStore });
  if (!result.ok) await fail(result.message);
  await done(result.message);
}

export async function removeReviewNote(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  const appId = String(formData.get("appId"));
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const result = await writeCandidateReview(user, openingId, appId, {
    action: "remove_note",
    noteId: String(formData.get("noteId") ?? ""),
  }, { ...OPENING_DEPS, invalidateCandidate, primeStore });
  if (!result.ok) await fail(result.message);
  await done(result.message);
}

/** The Add-on tag on an Excel Tables row, by hand (28 Sep). */
export async function toggleLinkAddOn(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const on = String(formData.get("on")) === "1";
  repo.setLinkAddOn(entryId, on);
  revalidatePath(`/openings/${openingId}/hh/links`);
  await done(on ? "Marked as an add-on." : "No longer an add-on.");
}

export async function toggleEyeMark(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  repo.toggleEyeMark(entryId);
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  const now = repo.linkVault(openingId).find((l) => l.id === entryId)?.isEyeMarked;
  await done(now ? "Eye-marked." : "Eye-mark removed.");
}


function readWorkLocations(form: FormData, previous: import("@/lib/workLocations").WorkLocation[] = []) {
  if (!form.has("workLocations")) return undefined;
  return validateWorkLocations(JSON.parse(String(form.get("workLocations"))), previous);
}

export async function assignWorkLocation(form: FormData) {
  const openingId = String(form.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorize(form, "opening.sourcing", { opening: "openingId" });
  try {
    if (isConvex()) await convexMutation("ta/workLocations:assign", { actorId: user.id, jobId: openingId,
      locationId: String(form.get("workLocationId") ?? ""), linkId: String(form.get("linkId") ?? "") || undefined,
      applicationId: String(form.get("applicationId") ?? "") || undefined });
    else {
      const location = requireWorkLocation(repo.opening(openingId)!, String(form.get("workLocationId") ?? ""))!;
      const row = repo.linkEntry(String(form.get("linkId") ?? ""));
      const app = repo.application(String(form.get("applicationId") ?? ""));
      if (!isDeskWide(user) && (row && row.addedBy !== user.id || app && app.ownerTaId !== user.id)) throw new Error("You can only assign your own candidates.");
      repo.assignWorkLocation(openingId, location.id, row?.id, app?.id);
    }
  } catch (e) { return fail(backendMessage(e, "Could not assign the work location.")); }
  revalidatePath(`/openings/${openingId}`, "layout");
  return back("Work location saved.");
}

/** A reviewed page of selected rows; each candidate and its links move atomically. */
export async function assignSelectedWorkLocations(form: FormData) {
  const openingId = String(form.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorize(form, "opening.sourcing", { opening: "openingId" });
  let location: ReturnType<typeof requireWorkLocation>;
  try { location = requireWorkLocation(repo.opening(openingId)!, String(form.get("targetWorkLocationId") ?? "")); }
  catch (e) { return fail(backendMessage(e, "Select a work location first.")); }
  if (!location) return fail("Set up the job's work locations first.");
  const entries = [...new Set(form.getAll("entryId").map(String))];
  const apps = [...new Set(form.getAll("appId").map(String))];
  if (!entries.length && !apps.length) return fail("Select candidates first.");
  if (entries.length + apps.length > 25) return fail("Assign up to 25 candidates at a time.");
  let saved = 0;
  const problems: string[] = [];
  for (const item of [...entries.map(linkId => ({ linkId })), ...apps.map(applicationId => ({ applicationId }))]) {
    try {
      if (isConvex()) await convexMutation("ta/workLocations:assign", { actorId: user.id, jobId: openingId, locationId: location.id, ...item });
      else {
        const row = "linkId" in item ? repo.linkEntry(item.linkId) : undefined;
        const app = "applicationId" in item ? repo.application(item.applicationId) : undefined;
        if (!isDeskWide(user) && (row && row.addedBy !== user.id || app && app.ownerTaId !== user.id)) throw new Error("You can only assign your own candidates.");
        repo.assignWorkLocation(openingId, location.id, row?.id, app?.id);
      }
      saved++;
    } catch (e) { problems.push(backendMessage(e, "A candidate could not be assigned.")); }
  }
  revalidatePath(`/openings/${openingId}`, "layout");
  return back(`Assigned ${saved} to ${location.name}.${problems.length ? ` ${problems.length} could not be assigned: ${[...new Set(problems)].slice(0, 2).join(" ")}` : ""}`, problems.length ? "note" : "ok");
}

// ─── Intake (spec §5) ────────────────────────────────────────────────────────

function readExtract(f: FormData): ExtractedBrief {
  const list = (v: FormDataEntryValue | null) =>
    String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  // Commas and currency go; a minus sign does not. Stripping it turned "-5000"
  // into 5000 (audit finding 40). A negative or zero amount is no amount.
  const num = (v: FormDataEntryValue | null) => {
    const n = Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    title: String(f.get("title") ?? "").trim(),
    salaryMin: num(f.get("salaryMin")),
    salaryMax: num(f.get("salaryMax")),
    currency: String(f.get("currency") ?? "LKR"),
    packageNotes: String(f.get("packageNotes") ?? "").trim(),
    locations: list(f.get("locations")),
    nationalities: list(f.get("nationalities")),
    headcount: Math.max(1, Number(f.get("headcount") ?? 1) || 1),
    mustHaves: String(f.get("mustHaves") ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
    clientNotes: String(f.get("clientNotes") ?? "").trim(),
    priorityTier: (String(f.get("priorityTier") ?? "P3") as PriorityTier),
  };
}

/**
 * Screen one of creating an opening. What it asks for depends on who is at it:
 *
 *   TA   — client and position. They are the recruiter, so assignment is implied.
 *   Lead — client, position, who it goes to, and the brief. A lead has no
 *          screen two because the JD is not theirs to write.
 *
 * Three ways out, and the one you press decides where you land: save and stop,
 * carry on to the JD (TA), or save and start the next one (lead, who is usually
 * booking several off a single client call).
 */
export async function createOpeningStep1(formData: FormData) {
  // Creating an opening needs users and clients — not every application in the
  // database. allApplications:true was a full scan of every candidate's record,
  // which made this 10–15 s slower than it needed to be (22 Sep).
  await primeStore({});

  const user = await authorize(formData, "opening.create");
  const next = String(formData.get("next") ?? "save");
  const openingId = await saveNewOpening(formData, user);
  // Returned nothing before, so an incomplete form was a button that did nothing.
  if (!openingId) await fail("Choose a client and a position.");

  if (next === "jd") redirect(`/openings/${openingId}/jd`);
  if (next === "again") redirect(`/openings/new?created=${openingId}`);
  redirect(`/openings/${openingId}`);
}

export type InlineResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Why the signed-in person may not do this, or null. For saves that answer rather than redirect. */
async function refusal(capability: Capability): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return "Your session has ended. Sign in again.";
  const decision = can(user, capability);
  return decision.ok ? null : decision.message;
}

/**
 * The same save, for the create-client pop-up: it answers instead of
 * navigating, so the pop-up can say what was made and offer where to go next
 * without the page jumping away underneath it.
 */
export async function createOpeningInline(
  formData: FormData,
): Promise<InlineResult<{ openingId: string; title: string; clientName: string }>> {
  await primeStore({});

  const refused = await refusal("opening.create");
  if (refused) return { ok: false, error: refused };
  const user = await authorize(formData, "opening.create");
  try {
    const openingId = await saveNewOpening(formData, user);
    if (!openingId) {
      return { ok: false, error: "Choose a client and a position." };
    }
    const clientId = String(formData.get("clientId") ?? "");
    return {
      ok: true,
      openingId: withRealIds(openingId),
      title: String(formData.get("title") ?? "").trim(),
      clientName: repo.clients().find((c) => c.id === clientId)?.name ?? "",
    };
  } catch (e) {
    return { ok: false, error: backendMessage(e, "The opening could not be saved. Try again.") };
  }
}

/** Screen one's write. Returns the new opening's id, or null when something required is missing. */
/** Screen one's fields, for the shared save (lib/openings/create, 22 Oct). Null when something required is missing. */
function saveNewOpening(formData: FormData, user: User): Promise<string | null> {
  return sharedSaveNewOpening(
    user,
    {
      clientId: String(formData.get("clientId") ?? ""),
      title: String(formData.get("title") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      recordingKey: String(formData.get("recordingKey") ?? "") || null,
      consentText: String(formData.get("consentText") ?? "") || null,
      durationMs: Number(formData.get("durationMs") ?? 0) || null,
      country: String(formData.get("country") ?? "").trim(),
      hiringFor: String(formData.get("hiringFor") ?? "local"),
      targetGender: String(formData.get("targetGender") ?? "").trim() || null,
      autoFollowUp: formData.get("autoFollowUp") === "on",
      workLocations: readWorkLocations(formData),
      assignedTaIds: formData.getAll("assignedTaIds").map(String),
    },
    { ...OPENING_DEPS, after },
  );
}

/** Screen two — the TA saves their notes before generating from them. */
export async function saveBriefNotes(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const result = await writeJdNotes(user, openingId, String(formData.get("notes") ?? ""), JD_DEPS);
  if (!result.ok) await fail(result.message);
  revalidatePath(`/openings/${openingId}`, "layout");
  await done(result.message);
}

/**
 * The TA generates the JD from the brief. Everything the brief yielded comes
 * through automatically; the TA corrects it here rather than anyone typing it
 * in twice.
 */
/** Spec §5.2 — the TA reads the JD and approves it; only then is it live. */
export async function approveJd(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const jd = String(formData.get("jdMarkdown") ?? "");
  const suggestionsBefore = repo.suggestions(openingId).length;
  const owner = repo.opening(openingId)?.assignedTaIds[0];
  const researched = !!repo.research(openingId);
  const result = await approveJdShared(user, openingId, jd, JD_DEPS);
  if (!result.ok) await fail(result.message);

  if (isConvex()) {
    // Approval in the backend also starts reading the JD's requirements
    // (skills, seniority, years, location, salary …) into the Job details.
    // Matching waits for that, so it scores against the real requirements.
    markMatching(openingId);
    // Research and the first Suggestions round wait for the approved JD, so
    // they search with the words the TA agreed (25 Sep). Before that they ran
    // on the first draft, the moment the opening was created.
    after(async () => {
      await Promise.all([
        rematchWhenRequirementsSettle(openingId, user.id),
        researched ? null : researchOpening(openingId, user.id).catch(() => undefined),
      ]);
      if (suggestionsBefore === 0) await sourceFor(openingId, owner).catch(() => undefined);
      revalidatePath(`/openings/${openingId}`, "layout");
    });
    await afterBackendWrite(openingId);
    if (String(formData.get("thenGo") ?? "") === "opening") {
      redirect(`/openings/${openingId}?msg=${encodeURIComponent("The job description is approved. The job is live.")}&tone=ok`);
    }
    await done(result.message);
    return;
  }

  // Spec §8A.2 — the first sourcing round starts here, without being asked. The
  // JD is the search vocabulary, so this is the first moment a good search is
  // possible, and a TA should find a list waiting rather than a button.
  // The database is searched for people we already hold who fit the JD
  // that was just agreed.
  after(async () => {
    await findDatabaseMatches(openingId, "jd_approved").catch(() => undefined);
    revalidatePath(`/openings/${openingId}`, "layout");
  });
  if (!researched) {
    after(async () => {
      await researchOpening(openingId, user.id).catch(() => undefined);
      revalidatePath(`/openings/${openingId}`, "layout");
    });
  }

  if (suggestionsBefore === 0) {
    // The auto-run belongs to the TA the opening is on, not to whoever
    // approved the JD — a lead approving it must not end up owning the list.
    // After the response: a round takes minutes, and approving a JD must not.
    after(async () => {
      await sourceFor(openingId, owner).catch(() => undefined);
      revalidatePath(`/openings/${openingId}`, "layout");
    });
  }

  revalidatePath(`/openings/${openingId}`, "layout");
  if (String(formData.get("thenGo") ?? "") === "opening") redirect(`/openings/${openingId}`);
}


// ─── Job posts (spec §4.3) ───────────────────────────────────────────────────

/**
 * Amending an approved JD — finding 01.
 *
 * It stays approved. Re-approving would take the opening off the live list
 * because a correction was made to a line, which is not what a correction
 * means; the change is stamped so the record still shows when it last moved.
 */
export async function amendJd(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const openingId = String(formData.get("openingId"));
  const jd = String(formData.get("jdMarkdown") ?? "");
  const result = await amendJdShared(user, openingId, jd, JD_DEPS);
  if (!result.ok) await fail(result.message);
  if (result.ok && result.reextracting) {
    markMatching(openingId);
    after(() => rematchWhenRequirementsSettle(openingId, user.id));
  }
  if (isConvex()) await afterBackendWrite(openingId);
  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(amendedJd(openingId, result.message));
}

function amendedJd(openingId: string, message: string) {
  return `/openings/${openingId}/jd?msg=${encodeURIComponent(message)}&tone=ok`;
}

/**
 * The TA tells the AI what to change in the JD, and it rewrites it — as many
 * times as it takes, until the TA approves it. Each answer keeps the JD it
 * produced, so an earlier one can be put back (restoreJdVersion).
 */
export async function reviseJd(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const result = await reviseJdShared(user, openingId, String(formData.get("request") ?? ""), String(formData.get("currentJd") ?? ""), JD_DEPS);
  if (!result.ok) await fail(result.message);
  if (result.ok && result.reextracting) {
    markMatching(openingId);
    after(() => rematchWhenRequirementsSettle(openingId, user.id));
  }
  if (isConvex()) await afterBackendWrite(openingId);
  else revalidatePath(`/openings/${openingId}`, "layout");
  await done(result.message);
}

/** Put back the JD an earlier answer in the JD chat produced. */
export async function restoreJdVersion(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const result = await restoreJdShared(user, openingId, String(formData.get("messageId") ?? ""), JD_DEPS);
  if (!result.ok) await fail(result.message);
  if (result.ok && result.reextracting) {
    markMatching(openingId);
    after(() => rematchWhenRequirementsSettle(openingId, user.id));
  }
  if (isConvex()) await afterBackendWrite(openingId);
  else revalidatePath(`/openings/${openingId}`, "layout");
  await done(result.message);
}

// ─── Job details: requirements extracted from the approved JD ────────────────

/**
 * The JD with its reviewed Job details appended, for the LinkedIn / X-ray
 * sourcing plan. The plan reads prose; a checked skills list and years floor
 * steer its search vocabulary better than the parser can recover from wording.
 */
function withJobDetails(o: import("@/data/types").Opening): string {
  const r = o.requirements;
  const jd = o.jdMarkdown || o.title;
  if (!r || (r.status !== "extracted" && !r.editedAt)) return jd;
  const lines = [
    r.requiredSkills.length ? `Required skills: ${r.requiredSkills.join(", ")}` : "",
    r.niceToHaveSkills.length ? `Nice to have: ${r.niceToHaveSkills.join(", ")}` : "",
    r.experienceMinYears ? `Experience: ${r.experienceMinYears}${r.experienceMaxYears ? `–${r.experienceMaxYears}` : "+"} years` : "",
    r.seniorityLevel ? `Seniority: ${r.seniorityLevel.replace(/_/g, " ")}` : "",
    r.location ? `Location: ${r.location}` : "",
    r.educationLevel ? `Education: ${r.educationLevel.replace(/_/g, " ")}` : "",
    r.languagesRequired.length ? `Languages: ${r.languagesRequired.join(", ")}` : "",
  ].filter(Boolean);
  return lines.length ? `${jd}\n\n## Job details (reviewed)\n${lines.map((l) => `- ${l}`).join("\n")}` : jd;
}

/** The structured salary range, as the sourcing salary rule reads it, when no free-text note exists. */
function salaryNoteOf(o: import("@/data/types").Opening): string {
  const r = o.requirements;
  if (!r || (r.salaryMin == null && r.salaryMax == null)) return "";
  const cur = r.salaryCurrency ?? "LKR";
  const fmt = (n: number | null) => (n == null ? "" : n.toLocaleString("en-US"));
  if (r.salaryMin != null && r.salaryMax != null) return `${cur} ${fmt(r.salaryMin)} - ${fmt(r.salaryMax)}`;
  return r.salaryMax != null ? `up to ${cur} ${fmt(r.salaryMax)}` : `from ${cur} ${fmt(r.salaryMin)}`;
}

/**
 * Wait for a requirements extraction to finish (it runs in the backend after
 * approval), then run matching against the result. Bounded: if extraction is
 * slow or failed, matching still runs on what the opening has.
 */
/** The matching run, shared with the mobile API (lib/openings/matching, 22 Oct). */
function rematchWhenRequirementsSettle(openingId: string, actorId: string, trigger: "jd_approved" | "manual" = "jd_approved") {
  return rematchShared(openingId, actorId, trigger, revalidatePath);
}

// Split the same way the backend does, so a comma inside brackets
// ("Version Control (e.g., Git)") never cuts a skill in two.
const listField = (formData: FormData, name: string) => splitSkills(String(formData.get(name) ?? ""));

const optionalNumber = (formData: FormData, name: string): number | null => {
  const raw = String(formData.get(name) ?? "").replace(/,/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
};

/** Save the Job details panel. What is saved is locked against automatic re-extraction. */
export async function saveJobDetails(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const minYears = optionalNumber(formData, "experienceMinYears");
  const maxYears = optionalNumber(formData, "experienceMaxYears");
  const salaryMin = optionalNumber(formData, "salaryMin");
  const salaryMax = optionalNumber(formData, "salaryMax");
  if ([minYears, maxYears, salaryMin, salaryMax].some((n) => Number.isNaN(n))) {
    await fail("Years and salary must be numbers.");
  }
  const result = await saveJdDetailsShared(user, openingId, {
    title: String(formData.get("title") ?? ""),
    clientIndustry: String(formData.get("clientIndustry") ?? "Other"),
    recruitmentType: (String(formData.get("recruitmentType") ?? "both") as "both" | "headhunting" | "job_posting"),
    isConfidential: formData.get("isConfidential") === "on",
    jobStatus: (String(formData.get("status") ?? "active") as "active" | "draft" | "on_hold"),
    location: String(formData.get("location") ?? ""),
    seniorityLevel: String(formData.get("seniorityLevel") ?? "other"),
    experienceMinYears: minYears ?? 0,
    experienceMaxYears: maxYears,
    educationLevel: String(formData.get("educationLevel") ?? ""),
    salaryMin,
    salaryMax,
    salaryCurrency: String(formData.get("salaryCurrency") ?? ""),
    requiredSkills: listField(formData, "requiredSkills"),
    niceToHaveSkills: listField(formData, "niceToHaveSkills"),
    languagesRequired: listField(formData, "languagesRequired"),
  }, JD_DEPS);
  if (!result.ok) await fail(result.message);
  markMatching(openingId);
  after(() => rematchWhenRequirementsSettle(openingId, user.id));
  await afterBackendWrite(openingId);
  await done(result.message);
}

/** Read the approved JD again and replace the details — including hand corrections. */
export async function reextractJobDetails(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const result = await reextractJdDetailsShared(user, openingId, JD_DEPS);
  if (!result.ok) await fail(result.message);
  markMatching(openingId);
  after(() => rematchWhenRequirementsSettle(openingId, user.id));
  await afterBackendWrite(openingId);
  await done(result.message);
}

export async function addJobPost(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const externalUrl = String(formData.get("externalUrl") ?? formData.get("jobLink") ?? "").trim() || null;
  // Creation, editing and EOD readiness accept the same LinkedIn link formats.
  if (externalUrl) {
    if (!linkedinPostUrl(externalUrl)) {
      await fail(
        "Paste a valid LinkedIn job, Recruiter project, or job post link.",
      );
    }
  }
  const where = String(formData.get("channel") ?? "linkedin");
  const channel = (["linkedin", "facebook", "email_campaign"] as const).find((c) => c === where) ?? "linkedin";
  const r = repo.addJobPost(openingId, title, user.id, String(formData.get("liveOnLinkedIn")) === "1", channel, externalUrl);
  if (!r.ok) await fail(r.message);
  revalidatePath(`/openings/${openingId}`, "layout");
  const reread = externalUrl ? await rereadMailboxFor(externalUrl) : false;
  await back(`Job post "${title}" added.${reread ? REREAD_NOTE : ""}`);
}

const REREAD_NOTE = " Checking linkedin@ for the last 30 days for this job's applicants — they appear in New CVs within a few minutes.";

/**
 * A LinkedIn link was saved: re-read the mailbox for the people who applied
 * before it was (convex/communications/emailAgent.ts rescanMailboxForLink,
 * 5 October). Only queued here; a failure to queue does not undo the save.
 */
async function rereadMailboxFor(url: string): Promise<boolean> {
  if (!isConvex()) return false;
  try {
    const r = await convexMutation<{ queued: boolean }>("communications/emailAgent:queueRescanForLink", { url });
    return !!r?.queued;
  } catch (e) {
    console.error("[posts] could not queue the mailbox re-read:", e);
    return false;
  }
}

export async function updatePost(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { post: "postId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const postId = String(formData.get("postId"));
  const aliases = String(formData.get("aliasKeywords") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const country = String(formData.get("country") ?? "").trim() || null;
  const assignedTaId = String(formData.get("assignedTaId") ?? "") || null;
  const patch: Partial<import("@/data/types").JobPost> = { aliasKeywords: aliases, country, assignedTaId };
  // The title as it reads on LinkedIn now. Renaming keeps the old one as a
  // previous title (store.updatePost), so applicants who clicked before the
  // edit still reach this post (post routing, 22 September).
  if (formData.has("title")) {
    const title = String(formData.get("title") ?? "").trim().replace(/\s+/g, " ");
    if (!title) await fail("A post needs the title candidates see.");
    patch.title = title.slice(0, 160);
  }
  if (formData.has("city")) patch.city = String(formData.get("city") ?? "").trim() || null;
  // The LinkedIn link carries a number LinkedIn puts in every application
  // email — the surest way to the right post. Either the job's own link, or
  // the Recruiter project's: `talent/hire/…`, or the "View applicant" link
  // copied from any application email for this job (22 September).
  const linkBefore = repo.jobPosts().find((p) => p.id === postId)?.externalUrl ?? null;
  if (formData.has("externalUrl")) {
    const url = String(formData.get("externalUrl") ?? "").trim();
    if (url && !linkedinPostUrl(url)) {
      await fail(
        "Paste a valid LinkedIn job, Recruiter project, or job post link.",
      );
    }
    patch.externalUrl = url || null;
  }
  const r = repo.updatePost(postId, patch);
  // A refusal is shown, not swallowed.
  if (!r.ok) await fail(r.message);
  revalidatePath(`/openings/${openingId}`, "layout");
  // A new or changed link: fetch the people who applied before it was saved.
  const reread = patch.externalUrl && patch.externalUrl !== linkBefore ? await rereadMailboxFor(patch.externalUrl) : false;
  await back(`Job post saved.${reread ? REREAD_NOTE : ""}`);
}

export async function updatePostInline(_: ActionResult | null, formData: FormData) {
  return inline(() => updatePost(formData));
}

/**
 * Which post an application email would be filed to — the same rules the
 * shared mailboxes use (convex/lib/postRouting.ts routeShared). Changes
 * nothing; it is for checking a post's title and aliases before the CVs come.
 */
export async function testPostRoute(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const subject = String(formData.get("subject") ?? "").trim();
  if (!subject) await fail("Paste an application email's subject first.");
  const { routeShared } = await import("../../convex/lib/postRouting");
  const open = new Set(repo.openings().filter((o) => o.status === "open").map((o) => o.id));
  const posts = repo
    .jobPosts()
    .filter((p) => open.has(p.openingId) && (p.status === "live" || p.status === "draft"));
  const pick = routeShared({ subject, body: String(formData.get("body") ?? ""), linkedinOnly: true }, posts);
  if (!pick) await note("No post matches this subject, so the CV would go to the database only. Add the title as an alias on the right post.");
  const name = (openingId: string, postId: string) => {
    const o = repo.opening(openingId);
    const p = posts.find((x) => x.id === postId);
    return `${p?.title ?? o?.title ?? "a post"}${o ? ` — ${repo.client(o.clientId)?.name ?? o.title}` : ""}`;
  };
  const how =
    pick!.how === "linkedin_job" ? "the LinkedIn job link" : pick!.how === "linkedin_project" ? "the LinkedIn project in the View applicant link" : pick!.how === "campaign_code" ? "the campaign code" : pick!.confidence === "keyword" ? `the alias "${pick!.matchedOn}"` : `the title "${pick!.matchedOn}"`;
  const also = pick!.alsoTo.length ? ` Also filed to: ${pick!.alsoTo.map((a) => name(a.openingId, a.postId)).join("; ")}.` : "";
  const here = pick!.openingId === String(formData.get("openingId")) ? "" : " (another opening)";
  await done(`Would go to ${name(pick!.openingId, pick!.postId)}${here}, by ${how}.${also}`);
}

export async function testPostRouteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => testPostRoute(formData));
}

export async function setPostStatus(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { post: "postId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const postId = String(formData.get("postId"));
  const status = String(formData.get("status")) as "draft" | "live" | "paused" | "closed";
  const r = repo.updatePost(postId, { status, postedAt: status === "live" ? Date.now() : undefined });
  // "Set live" before the JD is approved used to fail with no message at all.
  if (!r.ok) await fail(r.message);
  revalidatePath(`/openings/${openingId}`, "layout");
}

/** Spec §6.1 — one click moves a paused post's CVs onto the live one. */
export async function transferCvs(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { post: "fromPostId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const from = String(formData.get("fromPostId"));
  const to = String(formData.get("toPostId"));
  if (from && to && from !== to) repo.transferApplications(from, to);
  revalidatePath(`/openings/${openingId}`, "layout");
}


// ─── Phase 7: backups and add-ons ────────────────────────────────────────────

export async function declineOffer(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const reason = String(formData.get("reason") ?? "Declined the offer");
  repo.declineOffer(appId, reason, user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(
    `/openings/${openingId}/pipeline/dropped_out?msg=${encodeURIComponent(
      "Offer declined. They are out of the pipeline — look for a backup.",
    )}`,
  );
}

/**
 * Where the CAREER141 box sits on the Prepared CV (29 Sep): the TA drags it on
 * the Prepared CV tab and it stays there for the download and the end-of-day
 * attachment. Points from page 1's top-left; "reset" goes back to automatic.
 */
export async function savePreparedCvBox(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  if (String(formData.get("reset")) === "1") {
    repo.setPreparedCvBox(appId, null);
  } else {
    const x = Number(formData.get("x"));
    const y = Number(formData.get("y"));
    const width = Number(formData.get("width"));
    // A page is at most a few thousand points; anything else is not a drag.
    if (
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) ||
      x < 0 || y < 0 || x > 5000 || y > 5000 || width < 80 || width > 5000
    ) {
      await fail("That position could not be read. Drag the box again.");
    }
    repo.setPreparedCvBox(appId, {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(Math.min(Math.max(BOX.minWidth, width), BOX.maxWidth)),
    });
  }
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  revalidatePath(`/openings/${openingId}/eod`);
  await done(String(formData.get("reset")) === "1" ? "Box back to its automatic position and size." : "Box position and size saved.");
}

export async function savePreparedCvBoxInline(_: ActionResult | null, formData: FormData) {
  return inline(() => savePreparedCvBox(formData));
}

export async function toggleAddOn(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const on = String(formData.get("on")) === "1";
  repo.setAddOn(appId, on);
  revalidatePath(`/openings/${openingId}`, "layout");
  // Toggled silently before; only the tick changing gave it away (21 Sep).
  await done(on ? "Marked as an add-on — you and the lead are notified." : "No longer an add-on.");
}

/**
 * The Backup tag by hand (28 Sep). Shortlisting tags one on its own when the
 * role already has someone at interview or offer; this puts it on or takes it
 * off, and the end-of-day BACK-UP count follows.
 */
export async function toggleBackup(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const on = String(formData.get("on")) === "1";
  if (!repo.setBackup(appId, on)) {
    await fail("Could not mark as a backup — nobody on this role is at interview or offer yet.");
  }
  revalidatePath(`/openings/${openingId}`, "layout");
  await done(on ? "Marked as a backup." : "No longer a backup.");
}

// ─── Link vault (spec §4.5) ──────────────────────────────────────────────────

export async function updateLink(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const outcome = String(formData.get("outcome") ?? "") as import("@/data/types").LinkOutcome;
  const phoneNumber = String(formData.get("phoneNumber") ?? "").trim() || null;
  const phoneSource = (String(formData.get("phoneSource") ?? "") || null) as
    | import("@/data/types").LinkVaultEntry["phoneSource"];
  const name = String(formData.get("name") ?? "").trim() || null;
  const company = String(formData.get("company") ?? "").trim() || null;
  repo.updateLink(entryId, { outcome, phoneNumber, phoneSource, name, company });
  // A name, company or number typed in can make a match the bare link could not.
  const held = await matchLink(entryId, user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  // It saved silently; testers could not tell it had (21 Sep).
  await done(`${held && held.checkedAt > Date.now() - 60_000 ? heldLine(held) : ""}Saved — ${LINK_OUTCOME_LABEL[outcome] ?? outcome}.`);
}

const LINK_OUTCOME_LABEL: Record<string, string> = {
  no_contact: "Not contacted",
  contacted: "Contacted",
  responded: "Responded",
  cv_received: "CV received",
  shortlisted: "Shortlisted",
  declined: "Declined",
  unreachable: "Unreachable",
};

export async function logOutreach(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const note = String(formData.get("note") ?? "").trim();
  const channel = String(formData.get("channel") ?? "linkedin");
  if (!note) await fail("Write what happened on the approach first.");
  repo.logOutreach(entryId, user.id, channel, note);
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  await done(`Logged · ${channel === "whatsapp" ? "WhatsApp" : channel === "linkedin" ? "LinkedIn" : channel[0].toUpperCase() + channel.slice(1)}.`);
}


/**
 * "Add to pipeline" on an Excel Tables row: a headhunted person the TA has
 * shortlisted goes to Director Review, like any other shortlisted candidate.
 * They are claimed by this TA (which gives them their set number) and moved
 * through the normal stage rules, so the backend still refuses the move when
 * something Director Review needs has not been collected yet.
 */
export async function addLinkToPipeline(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.act", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));

  // From the row's edit panel the button also saves what was just typed —
  // and it means Shortlisted: pressing "Save and add to pipeline" and being
  // told "Set the outcome to Shortlisted first" at the top of the page was
  // the one thing it should not say (testing, 21 Sep).
  if (formData.has("outcome")) {
    await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
    repo.updateLink(entryId, {
      outcome: "shortlisted",
      phoneNumber: String(formData.get("phoneNumber") ?? "").trim() || null,
      phoneSource: (String(formData.get("phoneSource") ?? "") || null) as import("@/data/types").LinkVaultEntry["phoneSource"],
      name: String(formData.get("name") ?? "").trim() || null,
      company: String(formData.get("company") ?? "").trim() || null,
    });
  }

  const r = await pipelineFromLink(user, entryId, openingId);
  return r.tone === "error" ? fail(r.message) : r.tone === "note" ? note(r.message) : done(r.message);
}

/**
 * An Excel Tables row onto this opening's pipeline — what "Add to pipeline"
 * and "Interested" both do. Answers instead of redirecting, so a caller that
 * changed the row first can put it back when this is refused.
 */
async function pipelineFromLink(
  user: User,
  entryId: string,
  openingId: string,
): Promise<{ tone: "ok" | "note" | "error"; message: string }> {
  const marked = repo.linkVault(openingId).find((row) => row.id === entryId && row.isEyeMarked);
  if (marked) {
    const { eyeMarkedHasCv } = await import("@/lib/eyeMarked");
    if (marked.candidateId) await primeStore({ candidateIds: [marked.candidateId] });
    const candidate = marked.candidateId ? repo.candidate(marked.candidateId) : null;
    const app = repo.applications(openingId).find((a) => a.candidateId === marked.candidateId);
    if (!eyeMarkedHasCv(candidate ?? undefined, app))
      return { tone: "error", message: "Receive and link their CV before adding this eye-marked profile to the pipeline." };
  }
  const made = repo.linkToApplication(entryId, user.id);
  if (!made.ok) return { tone: "error", message: made.message };
  // Two TAs may hold the same person (22 Oct); the first to shortlist works
  // them. Said plainly here rather than "Already on this opening's pipeline",
  // which read as if the second TA had put them there.
  const owner = repo.application(made.applicationId)?.ownerTaId;
  if (owner && owner !== user.id && !isDeskWide(user)) {
    revalidatePath(`/openings/${openingId}/hh/links`);
    const who = repo.user(owner)?.name ?? "Another TA";
    return { tone: "error", message: `${who} shortlisted them first — they are working them${STAGE_LABEL[made.stage] ? ` (in ${STAGE_LABEL[made.stage]})` : ""}.` };
  }
  markTablesStale();
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  // Someone already on the opening: from Database CVs they go on to Follow-up
  // like anyone else; rejected or dropped out, they are brought back first.
  const isFollowUp = (s: string) => s === "ai_follow_up" || s === "ta_follow_up" || s === "follow_up";
  if (made.stage === "rejected" || made.stage === "dropped_out") {
    const r = await reinstate(user, made.applicationId, openingId);
    if (!r.ok) {
      return {
        tone: "error",
        message: `They were ${(STAGE_LABEL[made.stage] ?? made.stage ?? "").toLowerCase()} here and could not be brought back: ${r.message}`,
      };
    }
    made.stage = "ta_follow_up";
  }
  if (made.stage === "matched" || made.stage === "new_cv") made.stage = "ta_follow_up";
  if (!isFollowUp(made.stage)) {
    return { tone: "note", message: `Already on this opening's pipeline, in ${STAGE_LABEL[made.stage] ?? made.stage}.` };
  }

  if (isConvex()) {
    // The claim and the move are told apart (1 Oct): one try for both reported
    // a failed claim as "Director review needs their CV…", and the person sat
    // in TA Follow-up with nobody's name on them.
    let claimed: Awaited<ReturnType<typeof backend.shortlist>> | null = null;
    try {
      claimed = await backend.shortlist({ id: user.id }, made.applicationId);
    } catch (e) {
      await afterBackendWrite(openingId);
      // A note, not an error (2 Oct): the application already exists in TA Follow-up, so the
      // row reads Interested whatever this says — "Failed" over an Interested row told the TA
      // one thing and showed another, and a second press added nothing.
      return {
        tone: "note",
        message: `Added to TA Follow-up, but they were not claimed: ${backendMessage(e, "the claim was refused.")} Press Shortlist on their card to take them on.`,
      };
    }
    if (!claimed.ok) {
      const owner = repo.users().find((u) => u.id === claimed!.ownerTaId)?.name ?? "Another recruiter";
      await afterBackendWrite(openingId);
      // An error, so "Interested" puts the row back: the person is someone else's.
      return { tone: "error", message: `${owner} already claimed this candidate — they are working them.` };
    }
    let problem: string | null = null;
    try {
      await backend.moveStage({ id: user.id }, made.applicationId, "director_review");
    } catch (e) {
      problem = `Shortlisted — in TA Follow-up. Director review needs their CV, current and expected salary and notice period — add them on their page. (${backendMessage(e, "the move could not be made.")})`;
    }
    await afterBackendWrite(openingId);
    if (problem) return { tone: "note", message: problem };
    return { tone: "ok", message: "Added to the pipeline and moved to Director review." };
  }
  repo.shortlist(made.applicationId, user.id);
  const moved = repo.moveStage(made.applicationId, "director_review", user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
  if (!moved.ok) {
    return {
      tone: "note",
      message: `Added to the pipeline in Follow-up. Director review needs their CV, current and expected salary and notice period — add them on their page. (${moved.message})`,
    };
  }
  return { tone: "ok", message: "Added to the pipeline and moved to Director review." };
}

/**
 * Interested / Not interested on an Excel Tables row (the desk, 29 Sep).
 *
 * The row and the pipeline are one person, so they move together:
 * Interested puts them on this opening's pipeline the way "Add to pipeline"
 * does (TA Follow-up, then Director review when their details are complete),
 * and Not interested rejects them there with the reason "Not interested".
 * Nobody is deleted or copied. If the pipeline refuses, the row's outcome is
 * put back, so the table never says one thing while the pipeline says another.
 */
export async function setLinkInterest(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  await authorize(formData, "opening.act", { link: "entryId", opening: "openingId" });
  const entryId = String(formData.get("entryId"));
  const interest = String(formData.get("interest"));
  const entry = repo.linkVault(openingId).find((e) => e.id === entryId);
  if (!entry) return fail("That row is no longer in this table.");
  const before = entry.outcome;
  const refresh = () => {
    revalidatePath(`/openings/${openingId}`, "layout");
    revalidatePath(`/openings/${openingId}/hh/links`);
  };

  if (interest === "interested") {
    repo.updateLink(entryId, { outcome: "shortlisted" });
    const r = await pipelineFromLink(user, entryId, openingId);
    if (r.tone === "error") {
      // A backend write may have dropped the primed copy; load it again first.
      await primeStore({ openingId });
      repo.updateLink(entryId, { outcome: before });
      refresh();
      return fail(`Failed to update candidate status. ${r.message}`);
    }
    refresh();
    return r.tone === "note" ? note(`Interested. ${r.message}`) : done(`Interest status updated — Interested. ${r.message}`);
  }

  if (interest !== "not_interested") return fail("Pick Interested or Not interested.");
  // Why, in the TA's words (the desk, 29 Sep): it goes on the Rejected entry,
  // and on the row's log where the next person to open it reads it.
  // "Not interested, happy where he is" read "Not interested — Not interested,
  // happy…" (1 Oct): the words the label already says are not repeated.
  const why = String(formData.get("reason") ?? "")
    .trim()
    .replace(/^not\s+interested\b[\s,.:;—–-]*/i, "")
    .slice(0, 300);
  if (!why) return fail("Say why they are not interested — for example, happy where they are.");
  const rejectReason = `Not interested — ${why}`;
  const noteWhy = () => repo.logOutreach(entryId, user.id, "Not interested", why);
  const app = entry.candidateId
    ? (repo.applicationsForCandidate(entry.candidateId).find((a) => a.openingId === openingId) ?? null)
    : null;
  repo.updateLink(entryId, { outcome: "declined" });
  if (app && app.stage !== "rejected" && app.stage !== "dropped_out") {
    // Their pipeline entry is checked as any other move would be — the
    // collision lock included — before anything there changes.
    const undo = async (message: string) => {
      await primeStore({ openingId });
      repo.updateLink(entryId, { outcome: before });
      refresh();
      return fail(`Failed to update candidate status. ${message}`);
    };
    const allowed = can(user, "opening.act", {
      openingId,
      assignment: repo.assignmentFor(openingId, user.id) ?? null,
      ownerTaId: app.ownerTaId,
    });
    if (!allowed.ok) return undo(allowed.message);
    if (isConvex()) {
      try {
        await backend.moveStage({ id: user.id }, app.id, "rejected", rejectReason);
      } catch (e) {
        return undo(backendMessage(e, "They could not be moved to Rejected."));
      }
      await afterBackendWrite(openingId);
    } else {
      const res = repo.moveStage(app.id, "rejected", user.id, rejectReason);
      if (!res.ok) return undo(res.message);
    }
    // A backend write may have dropped the primed copy; load it before logging.
    await primeStore({ openingId });
    noteWhy();
    refresh();
    return done("Interest status updated — Not interested, and moved to Rejected on the pipeline.");
  }
  if (!app) {
    // Never on the pipeline: they go onto it as Rejected, so every Not
    // interested is in the Rejected column (the desk, 29 Sep). Written
    // straight there — nothing is sent, and no follow-up starts.
    const made = repo.linkToApplication(entryId, user.id, { rejected: rejectReason });
    if (!made.ok) {
      repo.updateLink(entryId, { outcome: before });
      refresh();
      return fail(`Failed to update candidate status. ${made.message}`);
    }
    // Written straight to Rejected, so its history says so and why.
    repo.logEvent({
      applicationId: made.applicationId, openingId, eventType: "rejected",
      fromStage: null, toStage: "rejected", actorType: "user", actorId: user.id, note: rejectReason,
    });
    noteWhy();
    markTablesStale();
    refresh();
    return done("Interest status updated — Not interested, and added to Rejected on the pipeline.");
  }
  // Already Rejected, or sent back here from the pipeline (Dropped out): the
  // pipeline does not move a dropped-out person straight to Rejected, and the
  // only way round starts follow-up to them, so it stays as it is.
  noteWhy();
  refresh();
  return done("Interest status updated — Not interested.");
}

/**
 * The + beside Excel Tables in the sidebar (the desk, 29 Sep): starts this
 * TA's next L on the opening — L1, then L2 — and opens it. Links they add
 * from now on go into it.
 */
export async function addLinkLevel(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  const n = repo.addLinkLevel(openingId, user.id, location?.id);
  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(`/openings/${openingId}/hh/links?level=${n}${location ? `&location=${location.id}` : ""}${ownSheetsParam(user)}`);
}

/** A lead's own L's open under their own name: on Everyone there are no L tabs (22 Oct). */
function ownSheetsParam(user: User): string {
  return isDeskWide(user) || seesEveryTaRow(user) ? `&by=${encodeURIComponent(user.id)}` : "";
}

/** A name for one of your L's on Excel Tables; blank puts the date back. */
export async function renameLinkLevel(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const n = Math.floor(Number(formData.get("level")));
  const name = String(formData.get("name") ?? "");
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  if (!repo.renameLinkLevel(openingId, user.id, n, name, location?.id)) return fail(`L${n} is not one of yours here.`);
  revalidatePath(`/openings/${openingId}`, "layout");
  return done(name.trim() ? `Renamed L${n} to ${name.trim().slice(0, 40)}.` : `L${n} shows its date again.`);
}

/**
 * One of your L's gone from the sidebar. Nothing else is: its rows stay in
 * the table under All, in no L, and the other L's keep their numbers.
 */
export async function deleteLinkLevel(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const n = Math.floor(Number(formData.get("level")));
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  const moved = repo.deleteLinkLevel(openingId, user.id, n, location?.id);
  if (moved === null) return fail(`L${n} is not one of yours here.`);
  revalidatePath(`/openings/${openingId}`, "layout");
  // Its links are shown where they went, with Undo above them (22 Oct).
  redirect(`/openings/${openingId}/hh/links?deleted=${n}${moved ? "&level=none" : ""}${location ? `&location=${location.id}` : ""}${ownSheetsParam(user)}`);
}

/** Undo a delete made a moment ago: the L and its links come back. */
export async function restoreLinkLevel(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const n = Math.floor(Number(formData.get("level")));
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  const back = repo.restoreLinkLevel(openingId, user.id, n, location?.id);
  if (back === null) return fail(`L${n} can no longer be put back. Start a new L-sheet and move its links there.`);
  revalidatePath(`/openings/${openingId}`, "layout");
  const msg = `L${n} is back${back ? ` with ${back === 1 ? "its link" : `its ${back} links`}` : ""}.`;
  redirect(`/openings/${openingId}/hh/links?level=${n}&msg=${encodeURIComponent(msg)}&tone=ok${location ? `&location=${location.id}` : ""}${ownSheetsParam(user)}`);
}

export async function renameLinkLevelInline(_: ActionResult | null, formData: FormData) {
  return inline(() => renameLinkLevel(formData));
}

export async function setLinkInterestInline(_: ActionResult | null, formData: FormData) {
  return inline(() => setLinkInterest(formData));
}

/**
 * The way back from "Add to pipeline": someone put on the pipeline from Excel
 * Tables goes back to their row there, with "Add to pipeline" on it again.
 *
 * Not a delete. They move to Dropped out with BACK_TO_TABLES_REASON, so their
 * history, calls and notes stay, and adding them again brings the same
 * application back instead of making a second one (29 Sep).
 */
export async function moveBackToTables(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  // opening.act with the application checks the collision lock too: only the
  // TA who owns them here, or a lead, can send them back.
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const app = repo.application(appId);
  if (!app) return fail("That candidate is no longer on this opening.");
  const row = repo.linkVault(openingId).find((l) => l.candidateId === app.candidateId);
  if (!row) return fail("They did not come from Excel Tables, so there is no row to go back to. Use Reject or Dropped out instead.");
  if (app.stage === "rejected" || app.stage === "dropped_out") {
    return fail(`They are already ${(STAGE_LABEL[app.stage] ?? app.stage).toLowerCase()}, not on the pipeline.`);
  }
  if (repo.offers(appId).length > 0 || repo.placements({ openingId }).some((p) => p.applicationId === appId)) {
    return fail("They have an offer or a placement on this opening, so they stay on the pipeline.");
  }
  // A TA may pull a candidate back from Interview too (the desk, 2 Oct). An interview still to
  // come would keep reminding a candidate who is no longer on the pipeline, so those are
  // cancelled once the move has gone through (below).
  const upcomingInterviews = repo.interviews(appId).filter((i) => i.outcome !== "cancelled" && i.scheduledAt > Date.now());

  if (isConvex()) {
    try {
      await backend.moveStage({ id: user.id }, appId, "dropped_out", BACK_TO_TABLES_REASON);
    } catch (e) {
      return fail(backendMessage(e, "They could not be moved back."));
    }
    await afterBackendWrite(openingId);
  } else {
    const r = repo.moveStage(appId, "dropped_out", user.id, BACK_TO_TABLES_REASON);
    if (!r.ok) return fail(r.message);
  }
  for (const i of upcomingInterviews) repo.setInterviewOutcome(i.id, "cancelled", user.id, BACK_TO_TABLES_REASON);
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  return done("Moved back to Excel Tables — \"Add to pipeline\" on their row puts them back.");
}

// ─── Opening admin (spec §4.2) ───────────────────────────────────────────────

/** Ask the responsible lead to add this TA to an opening. No opening access is
 * granted here; the backend records only a pending request and notification. */
export async function requestOpeningAccess(formData: FormData) {
  await primeStore({});
  const user = await getCurrentUser();
  // Shared with the mobile API (lib/openings/admin, 22 Oct).
  const r = await requestAccess(user, String(formData.get("openingId") ?? ""), String(formData.get("reason") ?? ""), OPENING_DEPS);
  await (r.ok ? (r.tone === "note" ? note : done) : fail)(r.message);
}

/** Approving and assigning happen in one backend transaction, so a requester
 * cannot gain partial access if a notification or audit write fails. */
export async function decideOpeningAccess(formData: FormData) {
  await primeStore({});
  const user = await getCurrentUser();
  // Shared with the mobile API (lib/openings/admin, 22 Oct).
  const r = await decideAccess(
    user,
    String(formData.get("requestId") ?? ""),
    String(formData.get("decision") ?? ""),
    String(formData.get("reason") ?? ""),
    OPENING_DEPS,
  );
  await (r.ok ? done : fail)(r.message);
}

export async function setOpeningStatus(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const status = String(formData.get("status")) as OpeningStatusValue;
  writeOpeningStatus(openingId, status, OPENING_DEPS);
}

export async function setWorkingStage(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const r = await writeWorkingStage(user, openingId, String(formData.get("stage")), OPENING_DEPS);
  return r.ok ? { ok: true as const } : { ok: false as const, message: r.message };
}

/** "We should be able to remove and add TAs" — answer 2, 11 Sep. */
/**
 * Who is on the opening, and as what.
 *
 * Arrives as parallel arrays from the repeatable rows. A team with nobody
 * recruiting it is refused — an opening with only a client contact on it would
 * be invisible to the desk that is supposed to be filling it.
 */
export async function setOpeningTeam(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const ids = formData.getAll("memberId").map(String);
  const roles = formData.getAll("memberRole").map(String);
  // Shared with the mobile API (lib/openings/admin, 22 Oct).
  const r = await writeOpeningTeam(user, openingId, ids.map((userId, i) => ({ userId, role: roles[i] })), OPENING_DEPS);
  if (!r.ok) redirect(`/openings/${openingId}?msg=${encodeURIComponent(r.message)}`);
}

export async function addClient(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const saved = await saveNewClient(formData, user);
  if (!saved) return;
  if (String(formData.get("action") ?? "save") === "create_job") {
    redirect(`/openings/new?client=${encodeURIComponent(saved.id)}`);
  }
}

/**
 * The create-client pop-up's save. It returns the client rather than
 * redirecting, so the pop-up can carry straight on into the opening form.
 */
export async function createClientInline(
  formData: FormData,
): Promise<InlineResult<{ client: { id: string; name: string; industry: string } }>> {
  await primeStore({ allApplications: true });
  const refused = await refusal("client.manage");
  if (refused) return { ok: false, error: refused };
  const user = await authorize(formData, "client.manage");
  try {
    const saved = await saveNewClient(formData, user);
    if (!saved) return { ok: false, error: "Give the company a name." };
    return { ok: true, client: saved };
  } catch (e) {
    return { ok: false, error: backendMessage(e, "The client could not be saved. Try again.") };
  }
}

/** The client forms' fields, for the shared save (lib/openings/create, 22 Oct). */
function saveNewClient(formData: FormData, user: User) {
  const field = (k: string) => String(formData.get(k) ?? "");
  return sharedSaveNewClient(
    user,
    { name: field("name"), industry: field("industry"), contactName: field("contactName"), contactTitle: field("contactTitle"), contactEmail: field("contactEmail") },
    OPENING_DEPS,
  );
}

export async function updateClient(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const clientId = String(formData.get("clientId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const esa = String(formData.get("esaSignedAt") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim() || "Other";
  const status = String(formData.get("status") ?? "active") as "active" | "dormant" | "archived";
  const esaSignedAt = esa ? new Date(esa).getTime() : null;
  // Only when the form carries the box, so a form without it never blanks it.
  const researchNotes = formData.has("researchNotes") ? String(formData.get("researchNotes") ?? "").trim() : undefined;

  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    await freshAfter(convexMutation)("ta/clients:update", {
      actorId: actor?._id,
      clientId,
      name,
      industry,
      status,
      esaSignedAt,
      ...(researchNotes !== undefined && { researchNotes }),
    });
  } else {
    repo.updateClient(clientId, {
      name,
      industry,
      status,
      esaSignedAt,
      ...(researchNotes !== undefined && { researchNotes }),
    });
  }
  revalidatePath("/clients");
  revalidatePath("/openings/new");
  await back("Client saved.");
}

export async function deleteClient(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const clientId = String(formData.get("clientId"));

  // Into the Bin for seven days, not gone (28 Sep) — see src/lib/bin.ts.
  const res = await binClientNamed(user, clientId);
  revalidatePath("/clients");
  revalidatePath("/openings/new");
  revalidatePath("/bin");
  // Refused because work is filed under it — the page says so rather than
  // pretending the press did nothing.
  if (!res.ok) redirect(`/clients?held=${res.openings}`);
  redirect(`/clients?msg=${encodeURIComponent(`${res.name} moved to the Bin. It will be deleted for good on ${purgeDateLabel(res.binnedAt)}.`)}&tone=ok`);
}

/** Move one client to the Bin, in whichever store is behind the app. */
async function binClientNamed(
  user: User,
  clientId: string,
): Promise<{ ok: true; name: string; binnedAt: number } | { ok: false; openings: number }> {
  if (isConvex()) {
    const { convexActorForEmail } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    const r = await freshAfter(
      convexMutation<{ ok: true; name: string; purgeAt: number } | { ok: false; openings: number; missing?: boolean }>,
    )("ta/bin:binClient", { actorId: actor?._id, clientId });
    return r.ok ? { ok: true, name: r.name, binnedAt: r.purgeAt - BIN_MS } : { ok: false, openings: r.openings };
  }
  const r = repo.binClient(clientId, user.id);
  return r.ok ? { ok: true, name: r.name, binnedAt: r.purgeAt - BIN_MS } : r;
}

/** Contacts arrive as parallel arrays from the repeatable rows. */
export async function saveContacts(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const clientId = String(formData.get("clientId"));
  const names = formData.getAll("contactName").map(String);
  const titles = formData.getAll("contactTitle").map(String);
  const emails = formData.getAll("contactEmail").map(String);
  const primary = String(formData.get("primary") ?? "0");

  const contacts = names.map((n, i) => ({
    name: n.trim(),
    title: (titles[i] ?? "").trim(),
    email: (emails[i] ?? "").trim(),
    isPrimary: String(i) === primary,
  }));

  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    await freshAfter(convexMutation)("ta/clients:saveContacts", {
      actorId: actor?._id,
      clientId,
      contacts,
    });
  } else {
    repo.setContacts(clientId, contacts);
  }
  revalidatePath("/clients");
  await back("Contacts saved.");
}

// ─── Deletes and edits (12 Sep sweep) ────────────────────────────────────────

export async function deleteOpening(formData: FormData) {
  await primeStore({ allApplications: true });
  // A lead or above, or a recruiter on this opening ("opening.manage"). Only
  // leads could while Delete was final; into the Bin it can be undone for
  // seven days, so TAs may bin their own openings (owner, 28 Sep).
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  // Into the Bin for seven days, not gone (28 Sep): it leaves every list and
  // stops following up at once, and anyone can restore it from the Bin.
  const r = await binOpeningNamed(user, openingId);
  if (!r.ok) await fail(r.message);
  if (isConvex()) {
    const { resetStore } = await import("@/data/prime");
    resetStore();
  }
  revalidatePath("/", "layout");
  const { title, purgeAt } = r as { title: string; purgeAt: number };
  redirect(
    `/openings?msg=${encodeURIComponent(`"${title}" moved to the Bin. It will be deleted for good on ${purgeDateLabel(purgeAt - BIN_MS)}.`)}&tone=ok`,
  );
}

/** Move one opening to the Bin — shared with the mobile API (lib/openings/writes). */
function binOpeningNamed(user: User, openingId: string) {
  return binOpeningShared(user, openingId, OPENING_DEPS);
}

/**
 * Everything the intake screen sets, changeable afterwards. A client who moves
 * the band or adds a second location is the normal case, not the exception.
 */
export async function updateOpening(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const field = (name: string, fallback = "") => String(formData.get(name) ?? fallback);
  const workLocations = readWorkLocations(formData, repo.opening(openingId)?.workLocations);
  // Checked and saved by the code the mobile API uses too (lib/openings/admin, 22 Oct).
  const r = writeOpeningDetails(
    openingId,
    {
      title: field("title"),
      salaryMin: field("salaryMin"),
      salaryMax: field("salaryMax"),
      salaryCurrency: field("salaryCurrency", "LKR"),
      packageNotes: field("packageNotes"),
      locations: field("locations"),
      targetNationalities: field("targetNationalities"),
      headcount: field("headcount", "1"),
      priorityTier: field("priorityTier", "P3"),
    },
    workLocations,
    OPENING_DEPS,
  );
  if (!r.ok) await fail(r.message);
  await back("Opening saved.");
}

/**
 * Save only the source cells exposed by the spreadsheet-style Master Sheet.
 * Calculated workflow cells never reach this action. A reason is compulsory so
 * the production mutation can keep a useful, attributable audit event.
 */
export async function updateMasterSheetOpening(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "commercial.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId") ?? "");
  const opening = repo.opening(openingId);
  if (!opening) await fail("That opening no longer exists. Reload the Master Sheet and try again.");
  const currentOpening = opening!;

  const rawStatus = String(formData.get("positionStatus") ?? "");
  if (!["active", "hold", "lost", "filled"].includes(rawStatus)) {
    await fail("Choose a valid position status.");
  }
  const positionStatus = rawStatus as MasterSheetPositionStatus;
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 3) await fail("Add a short reason for this Master Sheet change.");
  if (reason.length > 500) await fail("Keep the change reason under 500 characters.");

  const date = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").trim();
    const parsed = raw ? colomboDayFromValue(raw) : null;
    if (raw && parsed === null) throw new Error(`The ${name === "assignedAt" ? "assigned" : "closed"} date is invalid.`);
    return parsed;
  };
  const amount = (name: string): number | null => {
    const raw = String(formData.get(name) ?? "").replace(/,/g, "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Values must be zero or a positive number.");
    return parsed;
  };

  let input: Parameters<typeof backend.updateMasterSheetOpening>[2];
  try {
    input = {
      positionStatus,
      assignedAt: date("assignedAt"),
      closedAt: date("closedAt"),
      valueOnProgressing: amount("valueOnProgressing"),
      valueOfPlacement: amount("valueOfPlacement"),
      valueLost: amount("valueLost"),
      reason,
    };
  } catch (error) {
    await fail(error instanceof Error ? error.message : "One of the edited values is invalid.");
  }

  let changed = true;
  if (isConvex()) {
    try {
      const result = await backend.updateMasterSheetOpening({ id: user.id }, openingId, input!);
      changed = result.changed;
      markTablesStale();
    } catch (error) {
      await fail(backendMessage(error, "The Master Sheet row could not be saved."));
    }
  } else {
    const status = masterSheetStatusFields(positionStatus, input!.closedAt, currentOpening.closedAt);
    const patch = {
      positionStatus,
      status: status.status,
      assignedAt: input!.assignedAt,
      closedAt: status.closedAt,
      valueOnProgressing: input!.valueOnProgressing,
      valueOfPlacement: input!.valueOfPlacement,
      valueLost: input!.valueLost,
      updatedAt: Date.now(),
    };
    changed = Object.entries(patch).some(([key, value]) => currentOpening[key as keyof typeof currentOpening] !== value);
    if (changed) repo.updateOpening(openingId, patch);
  }

  revalidatePath("/reports");
  revalidatePath("/openings", "layout");
  revalidatePath(`/openings/${openingId}`, "layout");
  await done(changed ? "Master Sheet row saved." : "Nothing changed.");
}

export async function deleteJobPost(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { post: "postId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  repo.deleteJobPost(String(formData.get("postId")));
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function deleteLink(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  repo.deleteLink(String(formData.get("entryId")));
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  revalidatePath(`/openings/${openingId}/hh/links`);
  await done("Link removed from table.");
}

export async function removeApplication(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { application: "appId", opening: "openingId" });
  const user = await getCurrentUser();
  const openingId = String(formData.get("openingId"));
  const appId = String(formData.get("appId"));
  // Removing is a move to Dropped out with the reason "Removed", not a delete:
  // it took the application's history, calls and interviews with it and could
  // not be undone (plan 3.2, 21 Sep). "Bring back" reverses it.
  if (isConvex()) {
    try {
      await backend.moveStage({ id: user.id }, appId, "dropped_out", "Removed from the opening");
    } catch (e) {
      await fail(backendMessage(e, "They could not be removed."));
    }
    await afterBackendWrite(openingId);
  } else {
    const r = repo.moveStage(appId, "dropped_out", user.id, "Removed from the opening", { force: true });
    if (!r.ok) await fail(r.message);
    revalidatePath(`/openings/${openingId}`, "layout");
  }
  await done("Removed from the opening — they are under Dropped out, and can be brought back from there.");
}

/**
 * Several at once, from the list's tick boxes (components/BulkSelect, 25 Sep).
 *
 * Each one runs the single action exactly as its own button would — its
 * permission check, its lock, its message — and the answers are counted
 * instead of shown one by one. ponytail: sequential, each re-reading the
 * store; fine for a page of 25, batch it if people tick hundreds.
 */
async function eachInline(ids: string[], run: (id: string) => Promise<unknown>) {
  const results: ActionResult[] = [];
  for (const id of ids) results.push(await inline(() => run(id)));
  const ok = results.filter((r) => r.tone === "ok").length;
  const problems = [...new Set(results.filter((r) => r.tone !== "ok").map((r) => r.message))];
  return { ok, notOk: results.length - ok, problems };
}

function bulkSummary(r: { ok: number; notOk: number; problems: string[] }, did: string) {
  const first = `${r.ok} ${did}.`;
  if (!r.notOk) return first;
  return `${first} ${r.notOk} not: ${r.problems.slice(0, 2).join(" ")}${r.problems.length > 2 ? " …" : ""}`;
}

function one(formData: FormData, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of formData.entries()) if (typeof v === "string") fd.append(k, v);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

export async function removeApplications(formData: FormData) {
  const ids = formData.getAll("appId").map(String);
  if (ids.length === 0) await fail("Tick at least one candidate.");
  const r = await eachInline(ids, (appId) => removeApplication(one(formData, { appId })));
  await (r.ok ? (r.notOk ? note : done) : fail)(
    bulkSummary(r, "removed from the opening — they are under Dropped out"),
  );
}

export async function addManyToOpening(formData: FormData) {
  const ids = formData.getAll("candidateId").map(String);
  if (ids.length === 0) await fail("Tick at least one candidate.");
  if (!String(formData.get("openingId") ?? "")) await fail("Pick an opening.");
  const r = await eachInline(ids, (candidateId) => addToOpening(one(formData, { candidateId })));
  await (r.ok ? (r.notOk ? note : done) : fail)(bulkSummary(r, "added to the opening in TA Follow-up"));
}

/** Bulk selection never changes iMark; each row keeps its normal permission and pipeline gates. */
export async function addLinksToPipeline(formData: FormData) {
  const ids = [...new Set(formData.getAll("entryId").map(String))];
  if (!ids.length) return fail("Tick at least one candidate.");
  const r = await eachInline(ids, (entryId) => addLinkToPipeline(one(formData, { entryId })));
  await (r.ok ? (r.notOk ? note : done) : fail)(bulkSummary(r, "added to the pipeline"));
}

export async function moveSelectedCandidates(formData: FormData) {
  const stage = String(formData.get("stage") ?? "");
  // These milestones have dedicated flows for dates, offers and placements.
  if (!BULK_STAGES.includes(stage as Stage)) {
    return fail("Pick a stage. Use the candidate's page for interviews, offers and placements.");
  }
  const entries = [...new Set(formData.getAll("entryId").map(String))];
  const apps = [...new Set(formData.getAll("appId").map(String))];
  if (!entries.length && !apps.length) return fail("Tick at least one candidate.");
  const openingId = String(formData.get("openingId"));
  const r = await eachInline(entries.length ? entries : apps, async (id) => {
    let appId = id;
    if (entries.length) {
      const fd = one(formData, { entryId: id });
      await primeStore({ openingId });
      await authorize(fd, "opening.sourcing", { link: "entryId", opening: "openingId" });
      const entry = repo.linkVault(openingId).find((row) => row.id === id);
      const app = entry?.candidateId ? repo.applicationsForCandidate(entry.candidateId).find((a) => a.openingId === openingId) : null;
      if (!app || movedBackToTables(app) || awaitingShortlist(app)) return fail("Add this candidate to the pipeline first.");
      appId = app.id;
    }
    return moveStage(one(formData, { appId }));
  });
  await (r.ok ? (r.notOk ? note : done) : fail)(bulkSummary(r, `moved to ${STAGE_LABEL[stage as Stage]}`));
}

export async function deleteOpenings(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  // The same rule as the one-at-a-time delete, checked per opening below: a
  // lead or above, or a recruiter on that opening.
  const ids = formData.getAll("openingId").map(String);
  if (ids.length === 0) await fail("Tick at least one opening.");
  // The same loop the mobile API runs (lib/openings/writes).
  const { deleted, problems, message } = await binOpenings(user, ids, OPENING_DEPS);
  await (deleted ? (problems.length ? note : done) : fail)(message);
}

export async function deleteClients(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const ids = formData.getAll("clientId").map(String);
  if (ids.length === 0) await fail("Tick at least one client.");
  let deleted = 0;
  const kept: string[] = [];
  for (const clientId of ids) {
    const name = repo.client(clientId)?.name ?? "A client";
    let res: { ok: true } | { ok: false; openings: number };
    try {
      res = await binClientNamed(user, clientId);
    } catch (e) {
      kept.push(`${name} (${backendMessage(e, "could not be deleted")})`);
      continue;
    }
    if (res.ok) deleted++;
    else kept.push(`${name} (${res.openings ?? "has"} ${res.openings === 1 ? "opening" : "openings"})`);
  }
  if (isConvex()) markTablesStale();
  revalidatePath("/clients");
  revalidatePath("/openings/new");
  revalidatePath("/bin");
  // A client with work filed under it is kept, as the single delete does.
  const said = `${deleted} ${deleted === 1 ? "client" : "clients"} moved to the Bin. They can be restored for ${BIN_DAYS} days.`;
  await (deleted ? (kept.length ? note : done) : fail)(
    kept.length ? `${said} Kept — they still have openings: ${kept.join(", ")}.` : said,
  );
}

// ─── The Bin (28 Sep) ────────────────────────────────────────────────────────

function binTarget(formData: FormData): { kind: "opening" | "client"; id: string } {
  const kind = String(formData.get("kind")) === "client" ? "client" : "opening";
  return { kind, id: String(formData.get("id") ?? "") };
}

/** Out of the Bin, as it was. Anyone on the desk may — undoing a delete loses nothing. */
export async function restoreFromBin(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  if (isReadOnly(user) || user.role === "client") await fail("Only the desk can restore from the Bin.");
  const { kind, id } = binTarget(formData);
  let name = `The ${kind}`;
  let withClient = false;
  if (isConvex()) {
    try {
      const r = await convexMutation<{ ok: true; name: string; clientRestored?: boolean }>("ta/bin:restore", { actorId: user.id, kind, id });
      name = r.name;
      withClient = !!r.clientRestored;
    } catch (e) {
      await fail(backendMessage(e, "It could not be restored."));
    }
    const { resetStore } = await import("@/data/prime");
    resetStore();
  } else {
    const r = repo.restoreFromBin(kind, id);
    if (!r.ok) await fail(r.message);
    else name = r.name;
  }
  revalidatePath("/", "layout");
  await done(`${kind === "opening" ? `"${name}"` : name} restored${withClient ? ", with its client" : ""}.`);
}

/** Skip the seven days. A desk decision, like deleting an opening. */
export async function deleteFromBinNow(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  if (!isDeskWide(user)) await fail("Only a lead, director or admin can delete from the Bin early.");
  const { kind, id } = binTarget(formData);
  let name = `The ${kind}`;
  if (isConvex()) {
    try {
      name = (await convexMutation<{ ok: true; name: string }>("ta/bin:deleteNow", { actorId: user.id, kind, id })).name;
    } catch (e) {
      await fail(backendMessage(e, "It could not be deleted."));
    }
  } else {
    const r = repo.deleteFromBin(kind, id);
    if (!r.ok) await fail(r.message);
  }
  revalidatePath("/bin");
  await done(
    kind === "opening"
      ? `${name === "The opening" ? name : `"${name}"`} deleted for good. Its candidates are still in the database.`
      : `${name} deleted for good.`,
  );
}

/** Finding 13 — the edit and remove controls on a candidate's contact details. */
export async function updateCandidateContact(formData: FormData) {
  await primeStore({ allApplications: true, candidateIds: candidateIdsIn(formData) });
  const user = await getCurrentUser();
  const openingId = String(formData.get("openingId"));
  const candidateId = String(formData.get("candidateId"));
  const field = String(formData.get("field")) as "email" | "phone" | "name";
  if (field !== "email" && field !== "phone" && field !== "name") return;
  const app = repo.applications(openingId).find((row) => row.candidateId === candidateId);
  const result = await writeCandidateProfile(
    user,
    openingId,
    app?.id ?? "",
    { field, value: String(formData.get("value") ?? "") },
    OPENING_DEPS,
  );
  if (!result.ok) return fail(result.message);
  await back(result.message);
}

// ─── Interviews ──────────────────────────────────────────────────────────────

/**
 * Booking the interview is what moves the candidate into the stage.
 *
 * The stage machine refuses `interview` without a scheduled record, because
 * everything after it hangs off the time: the confirmation chase, the
 * escalation when it is not confirmed, the reminder, and the follow-up the
 * morning after. A stage with no date is a stage nobody can act on.
 */
export async function scheduleInterview(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const openingId = String(formData.get("openingId"));
  const appId = String(formData.get("appId"));
  const result = await writeCandidateInterview(user, openingId, appId, {
    action: "schedule",
    title: String(formData.get("title") ?? ""),
    date: String(formData.get("date") ?? ""),
    time: String(formData.get("time") ?? ""),
    timezone: String(formData.get("timezone") ?? "Asia/Colombo"),
    location: String(formData.get("location") ?? "").trim(),
    mode: String(formData.get("mode") ?? "in_person") as "in_person" | "video" | "phone",
    interviewers: String(formData.get("interviewers") ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean),
    durationMins: Number(formData.get("durationMins")) || null,
    notes: String(formData.get("notes") ?? ""),
  }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
  await done(result.message);
}

export async function confirmInterview(formData: FormData) {
  await primeStore({ allApplications: true });
  const interviewId = String(formData.get("interviewId"));
  const iv = repo.interviews().find((row) => row.id === interviewId);
  const result = await writeCandidateInterview(await getCurrentUser(), String(formData.get("openingId")), iv?.applicationId ?? "", { action: "confirm", interviewId }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
}

/** How it went, which is a different fact from whether they turned up. */
export async function setInterviewResult(formData: FormData) {
  await primeStore({ allApplications: true });
  const interviewId = String(formData.get("interviewId"));
  const iv = repo.interviews().find((row) => row.id === interviewId);
  const rating = String(formData.get("clientRating") ?? "").trim();
  const result = await writeCandidateInterview(await getCurrentUser(), String(formData.get("openingId")), iv?.applicationId ?? "", {
    action: "result",
    interviewId,
    result: String(formData.get("result") ?? "pending") as
      | "pending"
      | "passed"
      | "failed"
      | "on_hold",
    clientRating: rating ? Number(rating) as 1 | 2 | 3 | 4 | 5 : null,
    clientFeedback: String(formData.get("clientFeedback") ?? ""),
  }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
}

/**
 * Scheduled, completed, cancelled or no show. Each change is kept on the
 * interview's history, with the reason when one is given. "Scheduled" puts a
 * cancelled or no-show interview back on at the same time.
 */
export async function setInterviewOutcome(formData: FormData) {
  await primeStore({ allApplications: true });
  const interviewId = String(formData.get("interviewId"));
  const iv = repo.interviews().find((row) => row.id === interviewId);
  const picked = String(formData.get("outcome"));
  if (!["scheduled", "completed", "cancelled", "no_show"].includes(picked)) return fail("Pick a status.");
  const result = await writeCandidateInterview(await getCurrentUser(), String(formData.get("openingId")), iv?.applicationId ?? "", {
    action: "outcome", interviewId, outcome: picked as "scheduled" | "completed" | "cancelled" | "no_show", reason: String(formData.get("reason") ?? ""),
  }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
}

/** A new date and time for the same interview; the old one stays on its history. */
export async function rescheduleInterview(formData: FormData) {
  await primeStore({ allApplications: true });
  const interviewId = String(formData.get("interviewId"));
  const iv = repo.interviews().find((row) => row.id === interviewId);
  const result = await writeCandidateInterview(await getCurrentUser(), String(formData.get("openingId")), iv?.applicationId ?? "", {
    action: "reschedule", interviewId,
    date: String(formData.get("date") ?? ""),
    time: String(formData.get("time") ?? ""),
    location: String(formData.get("location") ?? "").trim(),
    mode: String(formData.get("mode") ?? "in_person") as "in_person" | "video" | "phone",
    reason: String(formData.get("reason") ?? ""),
  }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
  await done(result.message);
}

/** The interview's name, interviewers, length and notes. */
export async function editInterview(formData: FormData) {
  await primeStore({ allApplications: true });
  const interviewId = String(formData.get("interviewId"));
  const iv = repo.interviews().find((row) => row.id === interviewId);
  const result = await writeCandidateInterview(await getCurrentUser(), String(formData.get("openingId")), iv?.applicationId ?? "", {
      action: "edit", interviewId,
      title: String(formData.get("title") ?? ""),
      interviewers: String(formData.get("interviewers") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      durationMins: Number(formData.get("durationMins")) || null,
      notes: String(formData.get("notes") ?? ""),
    }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
  await done(result.message);
}

/**
 * The interviewer's view: scores, a recommendation and comments. Anyone on
 * the opening may give their own — the client's interviewer included — and
 * change it later; changing somebody else's is a lead's (mayChangeFeedback).
 */
export async function saveInterviewFeedback(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const interviewId = String(formData.get("interviewId"));
  const iv = repo.interviews().find((i) => i.id === interviewId);
  const forUserId = String(formData.get("forUserId") ?? "").trim() || user.id;
  const score = (k: string): 1 | 2 | 3 | 4 | 5 | null => {
    const n = Number(formData.get(k));
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n as 1 | 2 | 3 | 4 | 5 : null;
  };
  const rec = String(formData.get("recommendation") ?? "");
  const ratings = {
    technical: score("technical"), communication: score("communication"), behaviour: score("behaviour"),
    performance: score("performance"), overall: score("overall"),
  };
  const result = await writeCandidateInterview(user, String(formData.get("openingId")), iv?.applicationId ?? "", {
    action: "feedback", interviewId, forUserId,
    interviewer: String(formData.get("interviewer") ?? ""),
    ratings,
    recommendation: (["hire", "next_round", "hold", "reject"].includes(rec) ? rec : null) as
      | "hire" | "next_round" | "hold" | "reject" | null,
    comments: String(formData.get("comments") ?? ""),
  }, OPENING_DEPS);
  if (!result.ok) return fail(result.message);
  await done(result.message);
}

// ─── Director and client review rounds ───────────────────────────────────────

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * A saved report stores the query, never the figures — so reopening one next
 * month shows next month's numbers rather than a snapshot nobody can date.
 */
export async function saveReport(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "report.read");
  const name = String(formData.get("name") ?? "").trim();
  const spec = String(formData.get("spec") ?? "");
  if (!name) await fail("Give the report a name first.");
  if (!spec) await fail("There is no report on screen to save.");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(spec);
  } catch {
    await fail("This report could not be read, so it was not saved. Build it again and save.");
  }
  const id = repo.saveReport({
    name,
    ownerId: user.id,
    shared: String(formData.get("shared") ?? "") === "1",
    spec: parsed,
  });
  revalidatePath("/reports");
  // Land on the thing that was just saved, not back at the default.
  redirect(`/reports?report=${id}`);
}

/**
 * The English box. The model turns the sentence into a query and the query is
 * then run here, against the records — see lib/reportAsk for why it is never
 * allowed to return the answer itself.
 */
export async function askReport(formData: FormData) {
  // Only the small tables (users) are needed to say who is asking — not the
  // whole desk's applications, which this step never reads. It used to prime
  // those anyway and wait for the full, multi-thousand-row load before even
  // starting the model, on every question — including one the model goes on
  // to refuse. The page this redirects to primes the applications itself,
  // because that is where they are actually read; asking for them again here
  // first only delayed the model call for no reason (17 September).
  await primeStore();
  const user = await authorize(formData, "report.read");
  const question = String(formData.get("question") ?? "").trim();
  // An empty box did nothing at all (21 Sep).
  if (!question) redirect(`/reports?askErr=empty`);
  const { askForReport, resolveTaPerformanceQuestion, taPerformanceSpec } = await import("@/lib/reportAsk");
  const namedTa = resolveTaPerformanceQuestion(question, repo.users());
  if (namedTa.kind === "ambiguous" || namedTa.kind === "unknown") {
    redirect(`/reports?askErr=${namedTa.kind === "ambiguous" ? "ambiguous_ta" : "unknown_ta"}&q=${encodeURIComponent(question)}`);
  }
  if (namedTa.kind === "found") {
    if (!isDeskWide(user) && namedTa.user.id !== user.id) {
      redirect(`/reports?askErr=ta_access&q=${encodeURIComponent(question)}`);
    }
    const period = /\bthis month\b/i.test(question) ? "month" as const
      : /\b(this week|last 7 days)\b/i.test(question) ? "7" as const
      : /\b(last 30 days)\b/i.test(question) ? "30" as const
      : /\b(this quarter|last 90 days)\b/i.test(question) ? "90" as const
      : /\b(this year|last 12 months)\b/i.test(question) ? "365" as const : "all" as const;
    const q = new URLSearchParams({
      spec: JSON.stringify(taPerformanceSpec(namedTa.user.id, period)),
      name: `${namedTa.user.name} performance`,
      q: question,
    });
    redirect(`/reports?${q}`);
  }
  const res = await askForReport(question);

  if (!res.ok || !res.spec) {
    redirect(`/reports?askErr=${res.error ?? "bad_response"}&q=${encodeURIComponent(question)}`);
  }
  const q = new URLSearchParams({
    spec: JSON.stringify(res.spec),
    q: question,
    ...(res.title ? { name: res.title } : {}),
    ...(res.dropped.length ? { dropped: res.dropped.join("; ") } : {}),
  });
  redirect(`/reports?${q}`);
}

export async function deleteReport(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "report.read");
  repo.deleteReport(String(formData.get("reportId")), user.id);
  revalidatePath("/reports");
  redirect("/reports");
}

// ─── People (finding 11) ─────────────────────────────────────────────────────

// ─── People and roles — admin only ──────────────────────────────────────────
//
// In Convex mode the roster lives in the backend, and `repo`'s in-memory write
// is discarded on commit — so these used to look saved and change nothing.
// They now write through `ta/users`, which checks for an admin itself.

const DESK_ROLES = ["admin", "director", "ta_lead", "ta", "ta_support", "ops", "client", "viewer"] as const;

function personFrom(formData: FormData) {
  const role = String(formData.get("role") ?? "ta");
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    phone: String(formData.get("phone") ?? "").trim() || null,
    routingEmail: String(formData.get("routingEmail") ?? "").trim().toLowerCase() || null,
    role: (DESK_ROLES as readonly string[]).includes(role) ? (role as import("@/data/types").Role) : null,
    workCountry: readWorkCountry(formData.get("workCountry")),
  };
}

/** Run a roster write in the backend, then make the next read see it. */
async function saveRoster(run: () => Promise<unknown>, done: string): Promise<never> {
  try {
    await run();
  } catch (e) {
    await fail(safeErrorMessage(e, "That change could not be saved."));
  }
  const { refreshUsers } = await import("@/data/prime");
  await refreshUsers();
  revalidatePath("/", "layout");
  return back(done);
}

async function adminOnly(formData: FormData): Promise<User> {
  const actor = await authorize(formData, "user.manage");
  if (actor.role !== "admin") await fail("Only an admin can manage people and roles.");
  return actor;
}

export async function addUser(formData: FormData) {
  await primeStore({ allApplications: true });
  const actor = await adminOnly(formData);
  const p = personFrom(formData);
  if (!p.name) await fail("A name is required.");
  if (!p.email) await fail("An email is required — it is what they sign in with.");
  if (!p.role) await fail("Pick a role.");
  if (!isConvex()) {
    const id = repo.addUser({ name: p.name, email: p.email, phone: p.phone, routingEmail: p.routingEmail, role: p.role! });
    repo.updateUser(id, { workCountry: p.workCountry });
    revalidatePath("/people");
    return;
  }
  await saveRoster(
    () => convexMutation("ta/users:adminSaveUser", {
      actorId: actor.id, fullName: p.name, email: p.email, phone: p.phone, routingEmail: p.routingEmail, taRole: p.role, workCountry: p.workCountry,
    }),
    `${p.name} added as ${p.role}.`,
  );
}

export async function updateUser(formData: FormData) {
  await primeStore({ allApplications: true });
  const actor = await adminOnly(formData);
  const userId = String(formData.get("userId") ?? "");
  const p = personFrom(formData);
  if (!userId || !p.name || !p.email || !p.role) await fail("Name, email and role are all required.");
  if (!isConvex()) {
    repo.updateUser(userId, { name: p.name, email: p.email, phone: p.phone, routingEmail: p.routingEmail, role: p.role!, workCountry: p.workCountry });
    revalidatePath("/people");
    return;
  }
  await saveRoster(
    () => convexMutation("ta/users:adminSaveUser", {
      actorId: actor.id, userId, fullName: p.name, email: p.email, phone: p.phone, routingEmail: p.routingEmail, taRole: p.role, workCountry: p.workCountry,
    }),
    `${p.name} saved.`,
  );
}

/**
 * Invite someone with a role already decided.
 *
 * The roster entry is written FIRST, so the role is in place before the email
 * is even opened. An address already on the roster keeps its record and takes
 * the new role (and is brought back if they had left).
 */
export async function inviteUser(formData: FormData) {
  await primeStore({ allApplications: true });
  const actor = await adminOnly(formData);
  const p = personFrom(formData);
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) await fail("Enter the email address to invite.");
  if (!p.role) await fail("Pick a role.");
  const name = p.name || p.email.split("@")[0];
  if (!isConvex()) await fail("Invites need the Convex store (C141_STORE=convex).");

  const existing = repo.users().find((u) => u.email.trim().toLowerCase() === p.email);
  if (existing?.id === actor.id && p.role !== "admin") await fail("You can't change your own role here.");
  try {
    await freshAfter(convexMutation)("ta/users:adminSaveUser", {
      actorId: actor.id,
      userId: existing?.id,
      fullName: existing && !p.name ? existing.name : name,
      email: p.email,
      phone: existing && !p.phone ? existing.phone : p.phone,
      routingEmail: existing && !p.routingEmail ? existing.routingEmail : p.routingEmail,
      taRole: p.role,
    });
    if (existing && !existing.isActive) {
      await freshAfter(convexMutation)("ta/users:adminSetUserActive", { actorId: actor.id, userId: existing.id, isActive: true });
    }
  } catch (e) {
    await fail(safeErrorMessage(e, "Could not save the role."));
  }
  const { refreshUsers } = await import("@/data/prime");
  await refreshUsers();
  revalidatePath("/", "layout");

  const { sendInvite } = await import("@/lib/invites");
  const sent = await sendInvite(p.email, p.role!);
  await back(sent.ok ? `Invite sent to ${p.email} as ${p.role}.` : `Role saved for ${p.email}. ${sent.reason}`, sent.ok ? "ok" : "note");
}

/** Withdraw an invite link. Their roster entry stays; mark them as left to remove access too. */
export async function revokeUserInvite(formData: FormData) {
  await primeStore({ allApplications: true });
  await adminOnly(formData);
  const id = String(formData.get("invitationId") ?? "");
  if (!id) await fail("That invite could not be found.");
  const { revokeInvite } = await import("@/lib/invites");
  const r = await revokeInvite(id);
  revalidatePath("/people");
  await back(r.ok ? "Invite revoked. Mark them as left too if they should not get in." : r.reason, r.ok ? "ok" : "error");
}

export async function setUserActive(formData: FormData) {
  await primeStore({ allApplications: true });
  const actor = await adminOnly(formData);
  const userId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active")) === "1";
  if (!isConvex()) {
    repo.setUserActive(userId, active);
    revalidatePath("/people");
    return;
  }
  await saveRoster(
    () => convexMutation("ta/users:adminSetUserActive", { actorId: actor.id, userId, isActive: active }),
    active ? "Brought back." : "Marked as left.",
  );
}


// ─── Database search (spec §6D) ──────────────────────────────────────────────

/** Run a search: the sentence goes in the URL, the parser does the rest. */
export async function runDatabaseSearch(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "database.read");
  let said = String(formData.get("q") ?? "").trim();
  const mode = String(formData.get("mode") ?? "natural");
  const openingId = String(formData.get("openingId") ?? "");
  const cvFile = formData.get("cvFile");
  let referenceParam = "";
  const carriedReference = parseReferenceProfile(formData.get("ref"));
  if (carriedReference) referenceParam = serializeReferenceProfile(carriedReference);

  if (cvFile && typeof cvFile === "object" && "arrayBuffer" in cvFile && (cvFile as File).size > 0) {
    const file = cvFile as File;
    const fileProblem = referenceCvFileProblem(file.name, file.size);
    if (fileProblem) await back(fileProblem, "error");
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const { extractBlueprintFromFile } = await import("@/lib/referenceCv");
      const { blueprint: bp } = await extractBlueprintFromFile(buffer, file.name);
      referenceParam = serializeReferenceProfile(referenceProfileFromBlueprint(bp));
      if (!said) said = "Find candidates similar to this reference CV.";
    } catch (err) {
      console.warn("[runDatabaseSearch] CV document extraction fallback:", err);
      await back(safeErrorMessage(err, "Could not read that CV. Try a PDF, DOCX or TXT file."), "error");
    }
  }

  // A reply under the results carries on the conversation (5 Oct): the new
  // message is added to the search so far, one message per line (lib/query
  // turnsOf). Boolean is a literal string and always stands alone.
  const prior = mode === "boolean" ? "" : String(formData.get("prior") ?? "").trim();
  if (!said) redirect(prior ? `/database/results?${new URLSearchParams({ q: prior })}` : "/database");
  // The first message is one message too: a pasted job description has many
  // lines and was read as that many refinements, the last one winning (28 Oct).
  const oneLine = said.replace(/\s*\n+\s*/g, " ");
  const turns = prior ? [...prior.split(/\n+/).filter((t) => t.trim()), oneLine] : [oneLine];
  // How many people each earlier message showed, for the chat's replies (lib/query
  // turnCounts). One per earlier message or none; it only labels the chat.
  const rawCounts = String(formData.get("n") ?? "").slice(0, 400);
  const counts = prior && /^[\d,]*$/.test(rawCounts) ? rawCounts.split(",") : [];
  if (counts.length !== turns.length - 1) counts.length = 0;
  // Over 4,000 characters, the oldest refinements go — never the first request.
  while (turns.length > 2 && turns.join("\n").length > 4000) {
    turns.splice(1, 1);
    if (counts.length) counts.splice(1, 1);
  }
  const q = turns.join("\n").slice(0, 4000);
  const params = new URLSearchParams({ q });
  if (counts.length) params.set("n", counts.join(","));
  if (referenceParam) params.set("ref", referenceParam);
  if (mode === "boolean" || mode === "meaning") params.set("mode", mode);
  if (openingId) params.set("for", openingId);
  redirect(`/database/results?${params.toString()}`);
}

export async function saveSearch(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "database.read");
  const query = String(formData.get("q") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim() || query.slice(0, 60);
  const mode = String(formData.get("mode") ?? "natural") as "natural" | "boolean" | "meaning";
  const openingId = String(formData.get("openingId") ?? "") || null;
  const count = Number(formData.get("count") ?? 0);
  const intent = safeSearchIntent(formData.get("intent"));
  const turns = safeSearchTurns(formData.get("turns"));
  const savedReference = parseReferenceProfile(formData.get("ref"));
  const referenceProfile = savedReference ? serializeReferenceProfile(savedReference) : null;
  if (!query) return;

  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    // Persist to Convex DB so saved searches survive server restarts.
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    if (actor) {
      await freshAfter(convexMutation)("ta/search:saveSearch", {
        actorId: actor._id,
        name,
        query,
        mode,
        openingId: openingId ?? null,
        count,
        intent,
        turns,
        referenceProfile,
      });
    }
  } else {
    repo.saveSearch({ name, query, mode, ownerId: user.id, openingId, count, intent, turns, referenceProfile });
  }
  revalidatePath("/database", "layout");
  await back(`Search saved as "${name}".`);
}

function safeSearchTurns(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean).slice(-20) : [];
  } catch {
    return [];
  }
}

function safeSearchIntent(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const list = (key: string) => (Array.isArray(parsed[key]) ? parsed[key].map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : []);
    const strictness = parsed.strictness === "strict" || parsed.strictness === "flexible" ? parsed.strictness : "balanced";
    return {
      targetRole: typeof parsed.targetRole === "string" && parsed.targetRole.trim() ? parsed.targetRole.trim().slice(0, 120) : null,
      mustHave: list("mustHave"),
      niceToHave: list("niceToHave"),
      dealBreakers: list("dealBreakers"),
      softPreferences: list("softPreferences"),
      strictness,
      unknowns: list("unknowns"),
      clarifyingQuestions: Array.isArray(parsed.clarifyingQuestions) ? parsed.clarifyingQuestions.slice(0, 4) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "",
    };
  } catch {
    return null;
  }
}

export async function deleteSearch(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "database.read");
  const searchId = String(formData.get("searchId"));

  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    const user = await getCurrentUser();
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    if (actor) {
      await freshAfter(convexMutation)("ta/search:deleteSearch", { actorId: actor._id, searchId });
    }
  } else {
    repo.deleteSearch(searchId);
  }
  revalidatePath("/database", "layout");
}

/**
 * Put a candidate someone found — in the database search, on their profile, or
 * in the openings they may fit — into an opening's pipeline.
 *
 * They go straight to Follow-up, claimed by the person adding them, in their
 * current set: the same thing the Shortlist button does on Database CVs.
 * Until 16 September they landed at Matched, unclaimed — a stage that lives on
 * the Database CVs tab, not in the pipeline — so the candidate read as "on the
 * opening" everywhere except the pipeline the TA then went to look in.
 *
 * Someone already on the opening but still unclaimed at Matched or New CVs (for
 * one, every candidate added the old way) is claimed rather than refused.
 */
export async function addToOpening(formData: FormData) {
  await primeStore({ allApplications: true, candidateIds: candidateIdsIn(formData) });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const candidateId = String(formData.get("candidateId"));
  const openingId = String(formData.get("openingId"));
  if (!openingId) await fail("Pick an opening.");
  const title = repo.opening(openingId)?.title ?? "the opening";
  const refresh = () => {
    revalidatePath("/database", "layout");
    revalidatePath(`/candidates/${candidateId}`);
    revalidatePath(`/openings/${openingId}`, "layout");
  };

  const onOpening = () => repo.applications(openingId).find((a) => a.candidateId === candidateId);
  const existing = onOpening();
  // Rejected or dropped out is not "in the pipeline": they were refused with
  // "Already in X's pipeline" and could never be brought back (21 Sep).
  if (existing && (existing.stage === "rejected" || existing.stage === "dropped_out")) {
    const was = STAGE_LABEL[existing.stage];
    const r = await reinstate(user, existing.id, openingId);
    refresh();
    if (!r.ok) await fail(`They were ${was.toLowerCase()} on ${title} and could not be brought back: ${r.message}`);
    await done(`Back on ${title} in Follow-up — they had been ${was.toLowerCase()}.`);
  }
  if (existing && !["matched", "new_cv"].includes(existing.stage)) {
    await note(`Already on ${title}'s pipeline, in ${STAGE_LABEL[existing.stage]}.`);
  }
  if (existing?.ownerTaId && existing.ownerTaId !== user.id) {
    const owner = repo.users().find((u) => u.id === existing.ownerTaId)?.name ?? "another recruiter";
    await fail(`${owner} has already claimed this candidate on ${title}.`);
  }
  if (!existing) {
    const r = repo.addCandidateToOpening(candidateId, openingId, user.id);
    if (!r.ok) {
      refresh();
      await fail(r.reason ?? "Could not add them.");
    }
  }
  const appId = onOpening()?.id;
  if (!appId) {
    refresh();
    await note("They were added, but the application could not be found to move into Follow-up. Reload and use Shortlist on Database CVs.");
  }

  if (isConvex()) {
    // The backend's shortlist: the collision lock, the set number and the move
    // to Follow-up in one transaction, exactly as Database CVs claims.
    let r: Awaited<ReturnType<typeof backend.shortlist>> | null = null;
    let problem: string | null = null;
    try {
      r = await backend.shortlist({ id: user.id }, appId!);
    } catch (e) {
      problem = backendMessage(e, "could not be moved to Follow-up");
    }
    const owner = r && !r.ok ? repo.users().find((u) => u.id === r.ownerTaId)?.name ?? "another recruiter" : null;
    await afterBackendWrite(openingId);
    refresh();
    if (problem) await note(`Added to ${title} under Database CVs, but not moved to TA Follow-up: ${problem}`);
    if (owner) await fail(`${owner} has already claimed this candidate on ${title}.`);
    await done(`Added to ${title} in TA Follow-up${r?.ok && r.setNumber ? `, set ${r.setNumber}` : ""}.`);
  }

  const claimed = repo.shortlist(appId!, user.id);
  refresh();
  if (!claimed.ok) await fail("Somebody else claimed this candidate first.");
  await done(`Added to ${title} in TA Follow-up${claimed.ok && claimed.setNumber ? `, set ${claimed.setNumber}` : ""}.`);
}

/**
 * Place a mailbox CV that matched no post (convex/ta/unmatched.ts) on the job
 * it applied for. Unlike addToOpening it does not shortlist: they applied, so
 * they land in New CVs on the post, and the post's TA sees them there exactly
 * as if the email had routed (24 September).
 *
 * `target` is "openingId" or "openingId:postId".
 */
export async function placeUnmatched(formData: FormData) {
  const [openingId, postId] = String(formData.get("target") ?? "").split(":");
  if (!openingId) await fail("Pick the job they applied for.");
  formData.set("openingId", openingId);
  await primeStore({ allApplications: true, candidateIds: candidateIdsIn(formData) });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const candidateId = String(formData.get("candidateId"));
  const title = repo.opening(openingId)?.title ?? "the opening";
  const r = repo.addCandidateToOpening(candidateId, openingId, user.id, postId || null, { kind: "intake", source: "email" });
  revalidatePath("/intake");
  revalidatePath(`/openings/${openingId}`, "layout");
  if (!r.ok) await fail(`Could not place them on ${title}: ${r.reason ?? "unknown reason"}.`);
  await done(`Placed on ${title}, in New CVs.`);
}

export async function placeUnmatchedInline(_: ActionResult | null, formData: FormData) {
  return inline(() => placeUnmatched(formData));
}

// ─── Headhunting intelligence (spec §8A) ─────────────────────────────────────


export async function runResearch(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const res = await researchOpening(openingId, user.id, isDeskWide(user));
  revalidatePath(`/openings/${openingId}/hh/research`);
  if (!res.ok) await fail(`Research did not run — ${searchReasonInWords(res.reason ?? "", res.detail)}`);
  const filled = res.filled ?? 0;
  if (filled === 0) {
    await note(
      "The search ran but nothing could be sourced, so every field is still empty. Try again, or fill in what you know by hand.",
    );
  }
  const rivals = res.competitors ? ` and ${res.competitors} ${res.competitors === 1 ? "competitor" : "competitors"}` : "";
  if (res.modelNote) {
    await note(
      `The client's website, LinkedIn page${rivals} were found, but the AI could not sort the pages into fields — ${reasonInWords(res.modelNote)} Try again, or fill in the rest by hand.`,
    );
  }
  const o = repo.opening(openingId);
  const bench =
    res.people === undefined
      ? ` Benchmark was not run: ${o?.title ?? "this"} is a ${SENIORITY_LABEL[seniorityOf(o?.title ?? "")]} role — use Find them below if it is needed.`
      : res.benchmarkNote
        ? ` Benchmark could not name anyone — ${reasonInWords(res.benchmarkNote)}`
        : ` Benchmark: ${res.people} ${res.people === 1 ? "person" : "people"} holding the role, each with a source.`;
  await done(`Research filled in ${filled} of 8 fields${rivals}${res.sources ? ` from ${res.sources} sources` : ""}.${bench} Check anything going in front of the client.`);
}

export async function runBenchmark(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const o = repo.opening(openingId);
  if (!o) await fail("The opening could not be found. Reload the page and try again.");
  const client = repo.client(o!.clientId);
  if (!serperConfigured()) await fail(`Benchmark did not run — ${searchReasonInWords("no_serper")}`);
  // Once per opening, like Research (23 Sep). The rows are the record: a
  // senior role researched has already been benchmarked inside that run, so
  // this button is spent too — it is the same search, asked once. A lead can
  // run it again, as with Research.
  const already = repo.benchmarks(openingId);
  if (already.length && !isDeskWide(user)) {
    const when = dateAt(Math.max(...already.map((b) => b.generatedAt)));
    await fail(`Benchmark did not run — ${searchReasonInWords("benchmark_spent", when)}`);
  }
  // Who holds the role now, at the client and at the competitors Research
  // found — their own people pages, then the web (lib/incumbents, 22 Sep).
  // Pressed by hand, it runs for any role; Research runs it only for senior ones.
  const research = repo.research(openingId)?.fields;
  const run = await findIncumbents(
    {
      title: o!.title,
      where: o!.locations.join(", "),
      companies: [
        { name: client?.name ?? "the client", website: research?.websiteLink || null, isClient: true },
        ...(research?.competitorProfiles ?? []).map((c) => ({ name: c.name, website: c.website || null, isClient: false })),
      ],
    },
    WEB,
  );
  if (run.modelNote) await fail(`Benchmark did not run — ${reasonInWords(run.modelNote)}`);
  saveBenchmarks(openingId, run.rows);
  revalidatePath(`/openings/${openingId}/hh/research`);
  const searched = `${run.searches} web ${run.searches === 1 ? "search" : "searches"}`;
  if (run.rows.length === 0) {
    await note(
      `Nobody could be named (${searched}). A person is shown only when a page or search result says they hold the role${research ? "" : " — run Research first so the competitors are searched too"}.`,
    );
  }
  await done(`Found ${run.rows.length} ${run.rows.length === 1 ? "person" : "people"} holding the role, each with a source · ${searched}.`);
}

export async function pickBenchmark(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { benchmark: "entryId", opening: "openingId" });
  repo.toggleBenchmark(String(formData.get("entryId")));
  revalidatePath(`/openings/${String(formData.get("openingId"))}/hh`, "layout");
}

/**
 * The sourcing run itself, callable from the action or straight after the JD is
 * approved. Returns rather than redirects so the caller decides what happens.
 */
type SourceRun = { found: number; scanned: number; queries: number; cost: number; rejected?: number; note?: string; error?: string };

/**
 * `extraRound`: past the round limit — the rounds before were about the wrong company (correctClientAndRerun).
 * `learnedFrom`: a run that learns from that many picked CVs (learnFromPicks). It is
 * filed as round 0, so it never spends one of the TAs' three rounds.
 */
async function sourceFor(openingId: string, forUserId?: string, extraRound = false, learnedFrom?: number): Promise<SourceRun> {
  return alone(`suggest:${openingId}`, { found: 0, scanned: 0, queries: 0, cost: 0, error: "running" }, () => sourceForNow(openingId, forUserId, extraRound, learnedFrom));
}

/** The stages a TA has put someone in — TA Follow-up and on. AI Follow-up is the score's choice, not a TA's. */
const PICKED_STAGES = new Set(["ta_follow_up", "director_review", "director_shortlist", "client_shortlist", "interview", "offer", "placed"]);

/** The people the TAs picked for this opening, from their CVs (28 Oct). */
function pickedFor(openingId: string) {
  const ids = new Set(repo.applications(openingId).filter((a) => PICKED_STAGES.has(a.stage)).map((a) => a.candidateId));
  return [...ids].map((id) => repo.candidate(id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
}

/** One line per person, for the prompt (lib/claudeSourcing deskSignals). */
function deskSignalsFor(openingId: string, existing: import("@/data/types").ProfileSuggestion[]) {
  const line = (...xs: (string | number | false | null | undefined)[]) => xs.filter((x) => x !== false && x !== null && x !== undefined && String(x).trim()).join(", ");
  return {
    picked: pickedFor(openingId).slice(0, 10).map((c) =>
      line(c.currentTitle, c.currentEmployer && `at ${c.currentEmployer}`, c.totalExperienceYears != null && `${c.totalExperienceYears} years`, c.industries.slice(0, 3).join("/"), c.skills.slice(0, 6).join("; ")),
    ),
    selected: existing.filter((s) => s.status === "kept").slice(0, 15).map((s) => line(s.headline, s.company)),
    // "Not relevant" is a TA's Not selected (or the Assistant dropping someone);
    // rows set aside after a wrong-company run carry no feedback and teach nothing.
    notSelected: existing.filter((s) => s.status === "dismissed" && s.feedback === "not_relevant").slice(0, 15).map((s) => line(s.headline, s.company, s.concern)),
  };
}

async function sourceForNow(openingId: string, forUserId?: string, extraRound = false, learnedFrom?: number): Promise<SourceRun> {
  const o = repo.opening(openingId);
  if (!o) return { found: 0, scanned: 0, queries: 0, cost: 0, error: "no_opening" };
  const client = repo.client(o.clientId);
  const existing = repo.suggestions(openingId);
  const round = learnedFrom ? 0 : existing.length ? Math.max(...existing.map((s) => s.round)) + 1 : 1;
  if (round > MAX_ROUNDS && !extraRound) return { found: 0, scanned: 0, queries: 0, cost: 0, error: "rounds_spent" };

  const alreadyKnown = [
    ...repo.linkVault(openingId).map((l) => canonicalProfile(l.linkedinUrl)),
    ...existing.map((s) => canonicalProfile(s.linkedinUrl ?? "")),
  ].filter((x): x is string => Boolean(x));

  const run = await runSourcing(
    {
      title: o.title,
      clientName: client?.name ?? "the client",
      clientCompanyNames: [client?.name ?? ""].filter(Boolean),
      clientNotes: client?.researchNotes,
      jdText: withJobDetails(o),
      locations: o.locations,
      targetNationalities: o.targetNationalities,
      targetGender: o.targetGender,
      salaryNote: o.packageNotes || salaryNoteOf(o),
      targetEmployers: repo.benchmarks(openingId).filter((b) => b.isSelected).map((b) => b.company),
      alreadyKnown,
      ...deskSignalsFor(openingId, existing),
    },
    round,
  );
  if (run.error) return { found: 0, scanned: run.scanned, queries: run.queries.length, cost: run.cost, error: run.error };
  // A run belongs to whoever asked for it — see lib/visibility.
  repo.addSuggestions(
    openingId,
    run.suggestions.map((s) => ({ ...s, openingId, generatedFor: forUserId ?? null, keptBy: null, ...(learnedFrom ? { learnedFrom } : {}) })),
  );
  // A learning run is nobody's sourcing work for the day.
  if (isConvex() && !learnedFrom) await freshAfter(convexMutation)("ta/workdays:recordSourcingRun", { jobId: openingId, ...(forUserId ? { userId: forUserId } : {}), round, count: run.suggestions.length });
  return {
    found: run.suggestions.length, scanned: run.scanned,
    queries: run.queries.length, cost: run.cost,
    rejected: run.rejected ?? 0, note: run.note,
  };
}

/**
 * Suggestions that learn from the desk (28 Oct, the owner's "unique feature").
 * When 2 people are in TA Follow-up or later, and again at 5, 8, 11…, a run
 * starts by itself to find more people like them — no button, no reasons asked
 * of anyone. Called from the opening's layout, so it starts when someone works
 * the job; the backend that moves people into TA Follow-up cannot run Claude.
 * Its rows are round 0, so the TAs keep their three rounds.
 */
const learnTriedAt = new Map<string, number>();

export async function learnFromPicks(openingId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!allows(user, "opening.sourcing", { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null })) return;
  const existing = repo.suggestions(openingId);
  // Round 1 comes first, from the approved JD.
  if (!existing.length) return;
  const picked = pickedFor(openingId).length;
  if (picked < 2) return;
  const due = 2 + 3 * Math.floor((picked - 2) / 3);
  if (due <= Math.max(0, ...existing.map((s) => s.learnedFrom ?? 0))) return;
  // ponytail: per server and in memory — a run that finds nobody waits an hour
  // before trying again, and a restart forgets. Store the attempt if that matters.
  if (Date.now() - (learnTriedAt.get(openingId) ?? 0) < 60 * 60_000) return;
  learnTriedAt.set(openingId, Date.now());
  // Started from a layout's render, so no revalidatePath here: the next page
  // view reads the new rows (the opening's pages are dynamic).
  after(() => sourceFor(openingId, undefined, false, due).then(() => undefined, () => undefined));
}

export async function runSuggestions(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const r = await sourceFor(openingId, user.id);
  revalidatePath(`/openings/${openingId}/hh/suggestions`);
  if (r.error) await fail(`Suggestions did not run — ${searchReasonInWords(r.error)}`);
  const searched = `${r.scanned} profiles read from ${r.queries} searches`;
  if (r.found === 0) {
    await note(
      r.note === "nothing_survived_filter"
        ? `No new profiles this round (${searched}) — everyone found was already suggested or in Excel Tables. Keep or reject a few, or widen the brief, then refine.`
        : `No profiles found (${searched}). Widen the brief or tick target employers on Research, then try again.`,
    );
  }
  await done(`${r.found} new ${r.found === 1 ? "profile" : "profiles"} to review · ${searched}.`);
}

/**
 * "Wrong company?" on Research (28 Sep).
 *
 * The client "SQ" was researched as some other SQ: its website, overview,
 * competitors and the people Suggestions went looking for were all somebody
 * else's. Anyone sourcing the job can now say who the client really is — the
 * website, the LinkedIn page, the full name, what they do — and it is saved on
 * the CLIENT, so every job for them is researched right from then on.
 *
 * Saving new details buys one fresh run of both, past the once-per-job and
 * three-round limits: the earlier runs were about the wrong company, and a
 * correction nobody can act on is what makes people stop correcting. The same
 * details twice are refused — that is a re-run, not a correction.
 */
export async function correctClientAndRerun(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const o = repo.opening(openingId);
  const client = o ? repo.client(o.clientId) : null;
  if (!o || !client) await fail("This job has no client set. Set the client on the job first.");
  const notes = String(formData.get("researchNotes") ?? "").trim().slice(0, 2000);
  if (!notes) await fail("Write what you know about the client first — the website, the LinkedIn page or the full company name.");
  if (notes === (client!.researchNotes ?? "").trim()) {
    await fail("These are the details Research already has. Change or add something, then run again.");
  }

  if (isConvex()) {
    const actor = await convexActorForEmail(user.email);
    await freshAfter(convexMutation)("ta/clients:update", { actorId: actor?._id, clientId: client!.id, researchNotes: notes });
  } else {
    repo.updateClient(client!.id, { researchNotes: notes });
  }

  after(async () => {
    // Benchmark rows name people at the wrong company's competitors, and
    // Suggestions searches their employers first — they go before the re-run.
    repo.replaceBenchmarks(openingId, []);
    const res = await researchOpening(openingId, user.id, true).catch(() => null);
    if (res?.ok) {
      // Set aside, not deleted, and not marked "not relevant": nobody judged
      // them, and that mark steers the next round away from people like them.
      repo.dismissNewSuggestions(openingId);
      await sourceFor(openingId, user.id, true).catch(() => undefined);
    }
    revalidatePath(`/openings/${openingId}`, "layout");
  });
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath("/clients");
  await done(
    `Saved on ${client!.name}. Research and Suggestions are running again with these details — it takes a few minutes; reload this page to see them.`,
  );
}

/** Keeping a profile sends it to the link vault, where the approach is logged. */
export async function keepSuggestion(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { suggestion: "suggestionId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const id = String(formData.get("suggestionId"));
  const s = repo.suggestions(openingId).find((x) => x.id === id);
  if (!s) await fail("That suggestion is no longer there — the list may have been regenerated.");
  repo.setSuggestionStatus(id, "kept", "more_like_this", user.id);
  let held: CvMatch | null = null;
  let also = "";
  if (s!.linkedinUrl) {
    const already = linkFor(openingId, s!, user);
    if (already) {
      revalidatePath(`/openings/${openingId}/hh`, "layout");
      await note(`${s!.name ?? "They"} ${s!.name ? "is" : "are"} already in Excel Tables${already.addedBy !== user.id ? `, added by ${repo.user(already.addedBy)?.name ?? "another TA"}` : ""}.`);
    }
    const entryId = repo.addLink(openingId, s!.linkedinUrl, user.id);
    repo.updateLink(entryId, { name: s!.name, title: s!.headline, company: s!.company });
    held = await matchLink(entryId, user.id);
    const key = linkKey(s!.linkedinUrl);
    if (key) also = alsoHeldLine(otherHolders(repo.linksByUrl(openingId, key), user, deskWideCheck()));
  }
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  await back(`${heldLine(held)}${s!.name ?? "They"} selected and added to Excel Tables.${also}`);
}

/** The Excel Tables row a suggestion already has on this opening — by its address, or name and company (1 Oct). */
function linkFor(openingId: string, s: { linkedinUrl: string | null; name: string; company: string | null }, user: User) {
  const key = linkKey(s.linkedinUrl);
  const mine = rowCountsFor(user, deskWideCheck());
  return (key ? repo.findLinkByUrl(openingId, key, mine) : undefined) ?? repo.findLinkByPerson(openingId, s.name, s.company, mine);
}

/**
 * "Find CV" (1 Oct): who in our database might be this LinkedIn person — an
 * Excel Tables row, or a Suggestions result — for the TA to choose from.
 * Returns the people to the button; nothing is changed here.
 */
export async function findCv(input: {
  openingId: string;
  entryId?: string;
  suggestionId?: string;
}): Promise<{ ok: true; hits: CvHit[] } | { ok: false; message: string }> {
  await primeStore({ openingId: input.openingId });
  const user = await getCurrentUser();
  const assignment = repo.assignmentFor(input.openingId, user.id) ?? null;
  const allowed = can(user, "opening.sourcing", { openingId: input.openingId, assignment });
  if (!allowed.ok) return { ok: false, message: allowed.message };
  const profile = profileFor(input);
  if (!profile) return { ok: false, message: "That profile is no longer here. Reload the page." };
  try {
    return { ok: true, hits: await findCvCandidates(profile, user.id) };
  } catch (e) {
    console.warn("[findCv]", (e as Error).message);
    return { ok: false, message: "The search could not run just now. Try again." };
  }
}

/** What is known about a LinkedIn person on this opening, for "Find CV". */
function profileFor(input: { openingId: string; entryId?: string; suggestionId?: string }) {
  if (input.entryId) {
    const e = repo.linkEntry(input.entryId);
    if (!e || e.openingId !== input.openingId) return null;
    const cap = e.capture ?? null;
    return {
      linkedinUrl: e.linkedinUrl,
      name: e.name ?? cap?.fullName ?? null,
      phone: e.phoneNumber ?? cap?.phone ?? null,
      email: cap?.email ?? null,
      company: e.company ?? cap?.currentCompany ?? null,
      title: e.title ?? cap?.currentTitle ?? cap?.headline ?? null,
      location: cap?.location ?? null,
      employers: (cap?.experience ?? []).map((x) => x.company).filter(Boolean),
      ...captureHistory(cap),
    };
  }
  const s = input.suggestionId ? repo.suggestions(input.openingId).find((x) => x.id === input.suggestionId) : null;
  if (!s) return null;
  return { linkedinUrl: s.linkedinUrl, name: s.name, company: s.company, title: s.headline, location: s.location };
}

/**
 * The TA chose who this LinkedIn person is in our database (1 Oct): the row is
 * linked to that candidate, so their CV is used and no second record is made.
 * From Suggestions, the profile goes to Excel Tables already linked. The
 * chosen person is checked against a fresh search — only someone offered can
 * be chosen.
 */
export async function chooseCv(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const entryId = String(formData.get("entryId") ?? "") || undefined;
  const suggestionId = String(formData.get("suggestionId") ?? "") || undefined;
  const user = entryId
    ? await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" })
    : await authorize(formData, "opening.sourcing", { suggestion: "suggestionId", opening: "openingId" });
  const profile = profileFor({ openingId, entryId, suggestionId });
  if (!profile) return fail("That profile is no longer here. Reload the page.");
  const candidateId = String(formData.get("candidateId") ?? "");
  const hit = (await findCvCandidates(profile, user.id).catch(() => [] as CvHit[])).find((h) => h.candidateId === candidateId);
  if (!hit) return fail("That person is no longer offered for this profile. Press Find CV again.");

  let rowId = entryId;
  if (!rowId) {
    const s = repo.suggestions(openingId).find((x) => x.id === suggestionId)!;
    if (!s.linkedinUrl) return fail("This suggestion has no LinkedIn profile to add.");
    rowId = linkFor(openingId, s, user)?.id;
    if (!rowId) {
      rowId = repo.addLink(openingId, s.linkedinUrl, user.id);
      repo.updateLink(rowId, { name: s.name, title: s.headline, company: s.company });
    }
    repo.setSuggestionStatus(s.id, "kept", "more_like_this", user.id);
  } else {
    // A row already put on the pipeline as someone is changed there, not here.
    const e = repo.linkEntry(rowId)!;
    if (e.candidateId && e.candidateId !== hit.candidateId && repo.applicationsForCandidate(e.candidateId).some((a) => a.openingId === openingId)) {
      return fail("This row is already on the pipeline as someone else. Reject or drop them there first.");
    }
  }
  await linkRowTo(rowId, hit, user.id);
  revalidateLinks(openingId);
  revalidatePath(`/openings/${openingId}/hh`, "layout");
  return done(`Linked to ${hit.fullName}'s record${hit.hasCv ? " — their CV on file is used" : ""}. No new record was made.`);
}

export async function chooseCvInline(_: ActionResult | null, formData: FormData) {
  return inline(() => chooseCv(formData));
}

export async function dismissSuggestion(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { suggestion: "suggestionId", opening: "openingId" });
  repo.setSuggestionStatus(String(formData.get("suggestionId")), "dismissed", "not_relevant");
  revalidatePath(`/openings/${String(formData.get("openingId"))}/hh/suggestions`);
}

/**
 * Market research for an opening. Once per opening, for the whole desk.
 *
 * Search the client, search its competitors, read their pages, then sort what
 * was read into fields (lib/researchSearch, 22 Sep). Replaced one model call
 * that searched by itself and never opened the client's or a competitor's site.
 */
/**
 * Research or Suggestions already running for an opening, in this server.
 * Both start by themselves when a job is created (24 Sep); a TA pressing the
 * button while that run is still going would start a second one — twice the
 * searches, and two rounds numbered the same. The second press is told to wait.
 */
const runningNow = new Set<string>();

async function alone<T>(key: string, busy: T, work: () => Promise<T>): Promise<T> {
  if (runningNow.has(key)) return busy;
  runningNow.add(key);
  try {
    return await work();
  } finally {
    runningNow.delete(key);
  }
}

async function researchOpening(openingId: string, userId: string, canRerun = false): ReturnType<typeof researchOpeningNow> {
  return alone(`research:${openingId}`, { ok: false, reason: "running" }, () => researchOpeningNow(openingId, userId, canRerun));
}

async function researchOpeningNow(
  openingId: string,
  userId: string,
  /** A lead, director or admin may run it a second time. */
  canRerun = false,
): Promise<{
  ok: boolean;
  reason?: string;
  /** What the search provider said, when it was the search that failed. */
  detail?: string;
  filled?: number;
  sources?: number;
  competitors?: number;
  modelNote?: string;
  /** People found for Benchmark; undefined when it was not run. */
  people?: number;
  benchmarkNote?: string;
}> {
  const c = contextFor(openingId);
  const o = repo.opening(openingId);
  if (!c || !o) return { ok: false, reason: "no_opening" };
  // One attempt per opening, for the whole desk — 23 September. A run is about
  // thirty web searches and a model pass over everything they returned, and the
  // same client was being researched again and again.
  //
  // A lead, director or admin can still run it again, because an opening
  // created with the client's name misspelt would otherwise never be
  // researchable by anyone (review, 23 Sep).
  //
  // The report is the record, because it is written only when a run produced
  // one: a search the provider refused costs the opening nothing.
  const already = repo.research(openingId);
  if (already && !canRerun) {
    const who = repo.users().find((u) => u.id === already.generatedBy)?.name;
    return { ok: false, reason: "run_spent", detail: `${who ? `by ${who} ` : ""}on ${dateAt(already.generatedAt)}` };
  }
  const res = await researchViaSearch({
    clientName: c.clientName,
    industry: c.industry,
    where: c.locations.join(", "),
    title: c.title,
    // Who holds the role now — only worth finding for a senior or C-level role.
    benchmark: benchmarkByDefault(c.title),
    clientNotes: repo.client(o.clientId)?.researchNotes,
  });
  if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail };
  if (res.benchmarks) saveBenchmarks(openingId, res.benchmarks);
  // A field a TA corrected by hand survives a lead's re-run: the correction is
  // the better answer, and losing it is what made people stop correcting.
  const prior = repo.research(openingId);
  const fields = { ...res.fields };
  for (const k of prior?.editedFields ?? []) {
    if (k in fields && prior) {
      (fields as unknown as Record<string, unknown>)[k] =
        (prior.fields as unknown as Record<string, unknown>)[k];
    }
  }
  repo.saveResearch({
    openingId,
    clientId: o.clientId,
    fields,
    editedFields: prior?.editedFields ?? [],
    markdown: res.markdown,
    sources: res.sources,
    searches: res.searches,
    model: answeredByLabel(res.answeredBy),
    generatedBy: userId,
    generatedAt: Date.now(),
  });
  // The eight named fields; the competitor profiles are counted on their own.
  const { competitorProfiles, ...named } = fields;
  const filled = Object.values(named).filter((x) => (Array.isArray(x) ? x.length > 0 : String(x ?? "").trim() !== "")).length;
  return {
    ok: true,
    filled,
    sources: res.sources.length,
    competitors: competitorProfiles?.length ?? 0,
    modelNote: res.modelNote,
    people: res.benchmarks?.length,
    benchmarkNote: res.benchmarkNote,
  };
}

/** New benchmark rows, keeping the TA's ticks on anyone found again. */
function saveBenchmarks(openingId: string, rows: IncumbentRow[]) {
  const ticked = new Set(
    repo.benchmarks(openingId).filter((b) => b.isSelected).map((b) => `${(b.name ?? "").toLowerCase()}|${b.company.toLowerCase()}`),
  );
  repo.replaceBenchmarks(
    openingId,
    rows.map((r) => ({ ...r, openingId, isSelected: ticked.has(`${(r.name ?? "").toLowerCase()}|${r.company.toLowerCase()}`) })),
  );
}

export async function generateJdWithModel(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const result = await generateJdShared(user, openingId, String(formData.get("notes") ?? ""), JD_DEPS);
  if (!result.ok) await fail(result.message);
  if (isConvex()) await afterBackendWrite(openingId);
  else revalidatePath(`/openings/${openingId}`, "layout");
  if (result.ok && result.tone === "note") await note(result.message);
  await done(result.message);
}

/** A TA correcting a generated field. Marked, so regeneration leaves it alone. */
export async function editResearchField(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const key = String(formData.get("field"));
  const value = String(formData.get("value") ?? "");
  const r = repo.research(openingId);
  if (!r || !(key in r.fields)) return;
  const isList = Array.isArray((r.fields as unknown as Record<string, unknown>)[key]);
  repo.updateResearchField(
    openingId,
    key,
    isList ? value.split(/[;\n]/).map((x) => x.trim()).filter(Boolean) : value,
  );
  revalidatePath(`/openings/${openingId}/hh/research`);
  await back("Saved.");
}

// ─── The assistant (spec §8A.3) ──────────────────────────────────────────────

/**
 * A TA saying in words what the keep/reject buttons cannot: "drop anyone above
 * the band", "only CIMA qualified", "find more like Kevin Perera".
 *
 * The assistant decides which of two things the instruction is, because the two
 * cost differently and a TA should never be surprised by a bill:
 *
 *   REFINE — re-read the people already found. Free, instant, no round spent.
 *   SEARCH — go and find more. Spends one of the three rounds.
 */
export async function sendChatMessage(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;
  const o = repo.opening(openingId);
  if (!o) return;

  repo.addChat({ openingId, role: "user", body, action: null, affected: 0, sources: [], byUserId: user.id, at: Date.now() });

  const open = repo.suggestions(openingId).filter((s) => s.status === "new");
  const roster = open
    .map((s) => `${(s.linkedinUrl ?? "").split("/in/")[1] ?? s.name} | ${s.tier} | ${s.name} — ${s.headline} | ${s.why} | ${s.concern ?? ""}`)
    .join("\n");

  const prompt = `A recruiter is working a shortlist for this role and has asked you something.

ROLE: ${o.title} — ${o.locations.join(", ")} — ${o.packageNotes}
SPECIFICATION:
"""
${(o.jdMarkdown || o.title).slice(0, 3000)}
"""

THE CURRENT SHORTLIST (handle | tier | who | why | concern):
${roster || "(empty — nothing has been sourced yet)"}

THEY SAID: "${body}"

Decide which ONE of these it is and answer in exactly that format:

If it can be settled by re-reading the people above — reordering, retiering, or dropping some:
REFINE
CHANGES: handle=tier or handle=drop, semicolon separated. Only people who should change.
REPLY: one or two plain sentences telling them what you changed and why.

If it needs new people to be found:
SEARCH
TERMS: the specific extra search terms this implies, semicolon separated.
REPLY: one or two sentences saying what you will look for. Mention that it spends one of the three rounds.

If it is a question about the shortlist rather than an instruction:
ANSWER
REPLY: answer it from the evidence above. Where the evidence does not say, say that plainly rather than guessing.

Never invent a person. Never claim experience the lines above do not show.`;

  const res = await gemini("rank", prompt, { maxTokens: 3000 });
  if (!res.ok) {
    repo.addChat({
      openingId, role: "assistant",
      body:
        res.reason === "rate_limited"
          ? "The model is rate-limited right now — try again in a minute."
          : "I could not reach the model just then.",
      action: null, affected: 0, sources: [], byUserId: null, at: Date.now(),
    });
    revalidatePath(`/openings/${openingId}/hh/suggestions`);
    return;
  }

  const text = res.text;
  const reply = (text.match(/^REPLY:\s*([\s\S]*)$/im)?.[1] ?? text).trim().slice(0, 900);
  let action: "refine" | "search" | "answer" | null = null;
  let affected = 0;

  if (/^\s*REFINE\b/im.test(text)) {
    action = "refine";
    const line = text.match(/^CHANGES:\s*(.*)$/im)?.[1] ?? "";
    type Change = { url: string; tier?: "priority" | "screen"; drop?: boolean };
    const changes: Change[] = [];
    for (const raw of line.split(";")) {
      const [handle, what = ""] = raw.trim().split("=").map((y) => y.trim());
      if (!handle) continue;
      if (/^drop$/i.test(what)) changes.push({ url: handle, drop: true });
      else if (/^(priority|screen)$/i.test(what)) {
        changes.push({ url: handle, tier: what.toLowerCase() as "priority" | "screen" });
      }
    }
    // An instruction that empties the shortlist is almost never what was meant —
    // "drop anyone not in renewable energy" is a preference, not a rule, and
    // acting on it literally leaves a TA with nothing and no way back. So it is
    // reported rather than applied, and they decide.
    const dropping = changes.filter((c) => c.drop).length;
    const wouldEmpty = open.length > 0 && dropping >= Math.max(3, Math.ceil(open.length * 0.7));
    if (wouldEmpty) {
      repo.addChat({
        openingId, role: "assistant",
        body: `Taken literally that removes ${dropping} of ${open.length} — the whole list. That is usually a preference rather than a rule, so I have left it alone.\n\nIf it really is a hard requirement, the honest answer is that nobody found so far meets it, and the next step is another round with those terms rather than an empty page. Otherwise tell me to treat it as a preference and I will re-tier instead of dropping.`,
        action: "answer", affected: 0, sources: [], byUserId: null, at: Date.now(),
      });
      revalidatePath(`/openings/${openingId}/hh/suggestions`);
      return;
    }
    affected = repo.applyRefinement(openingId, changes);
  } else if (/^\s*SEARCH\b/im.test(text)) {
    action = "search";
  } else {
    action = "answer";
  }

  repo.addChat({
    openingId, role: "assistant", body: reply, action, affected,
    sources: [], byUserId: null, at: Date.now(),
  });
  revalidatePath(`/openings/${openingId}/hh/suggestions`);
}

// ─── Intake (the CV queue) ───────────────────────────────────────────────────
//
// Every one of these is a person pressing a button. Nothing in the intake path
// writes a candidate on its own — that is the difference between this queue and
// the live system's straight-through ingestion.

function intakeBack(id: string, msg?: string) {
  revalidatePath("/intake");
  redirect(`/intake/${id}${msg ? `?msg=${encodeURIComponent(msg)}` : ""}`);
}

export async function admitIntake(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "intake.handle", { intake: "itemId" });
  const id = String(formData.get("itemId"));
  const r = repo.admitIntake(id, user.id, {
    // Client-wide unless a form explicitly scopes it to one role.
    openingId: String(formData.get("openingId") ?? "") || null,
    force: String(formData.get("force")) === "1",
  });
  if (!r.ok) intakeBack(id, r.message);
  revalidatePath("/intake");
  revalidatePath("/database");
  redirect("/intake");
}

export async function mergeIntake(formData: FormData) {
  await primeStore({ allApplications: true, candidateIds: candidateIdsIn(formData) });
  const user = await authorize(formData, "intake.handle", { intake: "itemId" });
  const id = String(formData.get("itemId"));
  const r = repo.mergeIntake(id, String(formData.get("candidateId")), user.id);
  if (!r.ok) intakeBack(id, r.message);
  revalidatePath("/intake");
  revalidatePath("/database");
  redirect("/intake");
}

export async function rejectIntake(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "intake.handle", { intake: "itemId" });
  repo.rejectIntake(String(formData.get("itemId")), user.id, String(formData.get("note") ?? ""));
  revalidatePath("/intake");
  redirect("/intake");
}

/** Correcting a mis-read field before it can become a dedup key. */
export async function editIntakeParsed(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "intake.handle", { intake: "itemId" });
  const id = String(formData.get("itemId"));
  const s = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const years = String(formData.get("totalExperienceYears") ?? "").trim();
  repo.editIntakeParsed(id, {
    fullName: s("fullName"),
    email: s("email"),
    phone: s("phone"),
    linkedinUrl: s("linkedinUrl"),
    location: s("location"),
    currentTitle: s("currentTitle"),
    currentEmployer: s("currentEmployer"),
    totalExperienceYears: years === "" ? null : Number(years),
  });
  intakeBack(id, "Saved, and the identity check has been run again.");
}

export async function recheckIntake(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "intake.handle", { intake: "itemId" });
  const id = String(formData.get("itemId"));
  repo.recheckIntake(id);
  intakeBack(id, "Checked again against the database as it stands now.");
}

/**
 * The manual drop. This is the only way a file enters the queue in this build —
 * the mailbox, the WhatsApp number and the board feeds are wired and switched
 * off (lib/ingest), so there is nothing here that reaches out for somebody
 * else's CV.
 */
export async function dropIntake(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "intake.handle");
  await getCurrentUser();
  const text = String(formData.get("rawText") ?? "").trim();
  if (!text) redirect("/intake?msg=" + encodeURIComponent("Paste the CV text first."));
  const r = repo.receiveIntake({
    source: "upload",
    receivedFrom: "Pasted by hand",
    fileName: String(formData.get("fileName") ?? "").trim() || "Pasted CV.txt",
    rawText: text,
    openingId: String(formData.get("openingId") ?? "") || null,
  });
  revalidatePath("/intake");
  if (!r.ok) redirect("/intake?msg=" + encodeURIComponent(r.message));
  redirect(`/intake/${r.id}`);
}

// ─── Follow-up ───────────────────────────────────────────────────────────────
//
// Nothing here delivers a message. The drafts are composed and shown, a person
// sends them, and pressing Record tells the sequence it happened — which is
// also exactly the call the sender will make once the mailbox and the WhatsApp
// number are switched on.

export async function recordFollowUpAttempt(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const f = repo.followUp(appId);
  const openingId = f?.opening.id ?? String(formData.get("openingId") ?? "");
  const here = `/openings/${openingId}/candidate/${appId}?tab=chat`;
  const next = f?.followUp.next;

  // The schedule is enforced, not only displayed (audit finding 21): a message
  // is recorded when a message is what is owed, and not before its time.
  if (!f || !next) redirect(`${here}&msg=${encodeURIComponent("Nothing is owed on this one right now.")}`);
  if (!next.channels.some((c) => c === "whatsapp" || c === "email")) {
    redirect(`/openings/${openingId}/candidate/${appId}?tab=call&msg=${encodeURIComponent("The call is what is owed next — record how it went.")}`);
  }
  if (next.at > Date.now()) {
    redirect(`${here}&msg=${encodeURIComponent(`The next message is not due until ${dateAt(next.at)}.`)}`);
  }

  const only = String(formData.get("channel") ?? "");
  const drafts = draftsFor({
    candidate: f.candidate,
    missing: f.followUp.missing,
    roleTitle: f.opening.title,
    purpose: next.purpose,
    channels: next.channels,
    taName: user.name.split(" ")[0],
  }).filter((d) => !only || only === "both" || d.channel === only);

  const r = repo.recordAttempt({ applicationId: appId, drafts, byUserId: user.id });
  revalidatePath("/alerts");
  redirect(`${here}${r.ok ? "" : `&msg=${encodeURIComponent(r.message)}`}`);
}

/** How a follow-up call went: no answer, answered, call back at…, will send by…, not interested. */
export async function recordFollowUpCall(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const outcome = String(formData.get("outcome") ?? "") as FollowUpCallOutcome;
  if (!["no_answer", "answered", "callback", "will_send", "not_interested"].includes(outcome)) {
    await fail("Pick how the call went.");
  }
  const when = String(formData.get("promisedAt") ?? "").trim();
  const r = repo.recordCallOutcome({
    applicationId: appId,
    outcome,
    promisedAt: when ? colomboLocalToInstant(when) : null,
    note: String(formData.get("note") ?? ""),
    byUserId: user.id,
  });
  if (!r.ok) await fail(r.message);
  revalidatePath("/alerts");
  redirect(`/openings/${openingId}/candidate/${appId}?tab=call`);
}

/** Answers to the opening's own follow-up questions, and the standard three. */
export async function saveFollowUpAnswers(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const app = repo.application(appId)!;
  const extra: Record<string, string> = {};
  const standard: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("q_")) extra[k.slice(2)] = String(v).trim();
    if (k.startsWith("std_")) standard[k.slice(4)] = String(v).trim();
  }
  repo.saveAnswers(appId, Object.fromEntries(Object.entries(extra).filter(([, v]) => v)));
  const notice = standard.noticePeriodDays ? Number(standard.noticePeriodDays.replace(/[^\d]/g, "")) : null;
  repo.updateCandidate(app.candidateId, {
    ...(standard.currentSalary ? { currentSalary: standard.currentSalary } : {}),
    ...(standard.expectedSalary ? { expectedSalary: standard.expectedSalary } : {}),
    ...(notice !== null && Number.isFinite(notice) ? { noticePeriodDays: notice } : {}),
  });
  revalidatePath("/alerts");
  redirect(`/openings/${openingId}/candidate/${appId}?tab=chat&msg=${encodeURIComponent("Saved.")}`);
}

/**
 * Current salary, expected salary and notice period typed in by the TA, from
 * the candidate page's "Details for Director review" box. Blank fields leave
 * what is already on file.
 */
export async function saveReviewDetails(formData: FormData) {
  const applicationId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  await primeStore({ allApplications: true });
  const labels = formData.getAll("customLabel").map(String);
  const values = formData.getAll("customValue").map(String);
  const user = await getCurrentUser();
  const result = await writeCandidateReview(user, openingId, applicationId, {
    action: "details",
    currentSalary: String(formData.get("currentSalary") ?? ""),
    currentSalaryCurrency: String(formData.get("currentSalaryCurrency") ?? ""),
    expectedSalary: String(formData.get("expectedSalary") ?? ""),
    expectedSalaryCurrency: String(formData.get("expectedSalaryCurrency") ?? ""),
    noticePeriod: String(formData.get("noticePeriod") ?? formData.get("noticePeriodDays") ?? ""),
    currentDesignation: String(formData.get("currentDesignation") ?? ""),
    currentCompany: String(formData.get("currentCompany") ?? ""),
    customDetails: values.map((value, index) => ({ label: labels[index] ?? "", value })),
  }, { ...OPENING_DEPS, invalidateCandidate, primeStore });
  if (!result.ok) await fail(result.message);
  return done(result.message);
}

/**
 * The opening's automatic follow-up switch. On: after a TA's first Send, the
 * reminders go out every 24 hours by themselves, up to the attempt ceiling.
 */
export async function setOpeningAutoFollowUp(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const enabled = String(formData.get("enabled")) === "on";
  if (isConvex()) {
    try {
      await backend.setAutoFollowUp({ id: user.id }, openingId, enabled);
    } catch (e) {
      await fail(backendMessage(e, "Automatic follow-up could not be changed."));
    }
    await afterBackendWrite(openingId);
  } else {
    repo.setOpeningAutoFollowUp(openingId, enabled);
    revalidatePath(`/openings/${openingId}`, "layout");
  }
  await back(
    enabled
      ? "Automatic follow-up is on. Reminders go out every 24 hours after the first message you send."
      : "Automatic follow-up is off. Follow-ups go out only when you press Send.",
  );
}

/** The opening's own follow-up questions, one per line. */
export async function setOpeningQuestions(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const existing = repo.opening(openingId)?.followUpQuestions ?? [];
  const lines = String(formData.get("questions") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // Keep a question's id when its wording is unchanged, so answers already
  // given stay attached to it.
  const questions = lines.map((label) => ({
    id: existing.find((q) => q.label === label)?.id ?? `q${Math.random().toString(36).slice(2, 8)}`,
    label,
  }));
  repo.setOpeningQuestions(openingId, questions);
  revalidatePath(`/openings/${openingId}`, "layout");
  await back("Follow-up questions saved.");
}

/**
 * One more follow-up question for this opening, asked from the Follow-up page
 * (plan 3.4, 21 Sep: the only place to add one was a collapsed box at the
 * bottom of the Overview). It goes out with the next follow-up to everyone
 * still in Follow-up, and nobody counts as complete until it is answered.
 */
export async function addOpeningQuestion(formData: FormData) {
  await primeStore({ allApplications: true });
  // The same seats as editing the question list (setOpeningQuestions): a
  // question goes out to everyone in Follow-up and holds their completion
  // (review of PR #2, 21 Sep).
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const label = String(formData.get("question") ?? "").trim().replace(/\s+/g, " ");
  if (!label) await fail("Type the question first.");
  if (label.length > 200) await fail("Keep the question under 200 characters — it goes out on WhatsApp.");
  const existing = repo.opening(openingId)?.followUpQuestions ?? [];
  if (existing.some((q) => q.label.toLowerCase() === label.toLowerCase())) {
    await note("That question is already asked on this opening.");
  }
  repo.setOpeningQuestions(openingId, [...existing, { id: `q${Math.random().toString(36).slice(2, 8)}`, label }]);
  revalidatePath(`/openings/${openingId}`, "layout");
  const waiting = repo.applications(openingId).filter((a) => a.stage === "ai_follow_up" || a.stage === "ta_follow_up" || (a.stage as string) === "follow_up").length;
  await done(
    waiting
      ? `Question added. It goes with the next follow-up to the ${waiting} ${waiting === 1 ? "person" : "people"} in Follow-up.`
      : "Question added. It will be asked in every follow-up on this opening.",
  );
}

export async function addOpeningQuestionInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addOpeningQuestion(formData));
}

export async function setAutoShortlistScore(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const n = Math.round(Number(formData.get("score")));
  if (!Number.isFinite(n) || n < 40 || n > 100) await fail("Pick a score between 40 and 100.");
  repo.setSetting("autoShortlistScore", String(n));
  revalidatePath("/", "layout");
  await back(`Pre-shortlist score set to ${n}.`);
}

// ─── Database matches (13 September) ────────────────────────────────────────

/**
 * Run database matching again, from the matching banner (MatchingStatus).
 *
 * After the response, like every other run: it takes up to a minute and a
 * half, and the banner shows it running and then what it added (25 Sep).
 */
export async function findMatchesNow(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const r = startMatching(user, openingId, { revalidatePath, schedule: (work) => after(work) });
  await (r.ok ? done : fail)(r.message);
}

/** The desk's standard questions — which are asked, and how they read. */
export async function setFollowUpStandard(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const rows = repo.followUpStandard().map((q) => ({
    id: q.id,
    enabled: formData.get(`on_${q.id}`) === "1",
    label: String(formData.get(`label_${q.id}`) ?? q.label),
  }));
  repo.setFollowUpStandard(rows);
  revalidatePath("/", "layout");
  await back("Standard questions saved.");
}

export async function logFollowUpReply(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const body = String(formData.get("body") ?? "").trim();
  const here = `/openings/${openingId}/candidate/${appId}?tab=chat`;
  if (!body) redirect(`${here}&msg=${encodeURIComponent("Paste what they said first.")}`);

  const r = repo.recordReply({
    applicationId: appId,
    channel: String(formData.get("channel") ?? "whatsapp") as "whatsapp" | "email",
    body,
    byUserId: user.id,
  });
  revalidatePath("/alerts");
  revalidatePath("/database");
  const left = repo.followUp(appId)?.followUp.missing ?? [];
  const msg = !r.ok
    ? r.message
    : `Logged.${r.applied.length ? ` Read out of it: ${r.applied.join(", ")}.` : ""}${
        left.length ? ` Still missing: ${left.map((q) => q.label.toLowerCase()).join(", ")}.` : " Everything is in."
      }`;
  redirect(`${here}&msg=${encodeURIComponent(msg)}`);
}

// ─── Closing records ─────────────────────────────────────────────────────────

export async function makeOffer(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const rawSalary = String(formData.get("salary") ?? "").replace(/[^\d.]/g, "");
  const salary = rawSalary && Number.isFinite(Number(rawSalary)) ? Number(rawSalary) : 0;
  const r = await writeCandidateClosing(user, openingId, appId, {
    action: "offer",
    salary,
    salaryBasis: String(formData.get("salaryBasis") ?? "monthly") as "monthly" | "annual",
    currency: String(formData.get("currency") ?? "LKR") as "LKR" | "USD",
    startDate: String(formData.get("startDate") ?? ""),
    terms: String(formData.get("terms") ?? ""),
  }, OPENING_DEPS);
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function respondToOffer(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = await writeCandidateClosing(user, openingId, appId, {
    action: "respond",
    offerId: String(formData.get("offerId")),
    status: String(formData.get("status")) as "accepted" | "declined" | "withdrawn",
    reason: String(formData.get("reason") ?? ""),
  }, OPENING_DEPS);
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function recordPlacement(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = await writeCandidateClosing(user, openingId, appId, {
    action: "place",
    offerId: String(formData.get("offerId")),
    joinDate: String(formData.get("joinDate") ?? ""),
  }, OPENING_DEPS);
  if (!r.ok)
    redirect(`/openings/${openingId}/candidate/${appId}?msg=${encodeURIComponent(r.message)}`);
  redirect(`/placements/${r.placementId}`);
}

// ─── Screening calls ─────────────────────────────────────────────────────────
//
// Nothing here dials anybody. The dry run writes nothing; the assisted mode is
// a TA on the phone typing what they hear; the voice agent is built and off.

export async function startCall(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = repo.startCall({
    applicationId: appId,
    mode: String(formData.get("mode") ?? "assisted") as import("@/data/types").CallMode,
    byUserId: user.id,
  });
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function recordConsent(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "applicationId", call: "callId", opening: "openingId" });
  await getCurrentUser();
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = repo.recordConsent(
    String(formData.get("callId")),
    String(formData.get("decision")) as "granted" | "declined",
  );
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function recordCallAnswer(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "applicationId", call: "callId", opening: "openingId" });
  await getCurrentUser();
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = repo.recordAnswer({
    callId: String(formData.get("callId")),
    field: String(formData.get("field")) as import("@/data/types").CallField,
    heard: String(formData.get("heard") ?? ""),
  });
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function finishCall(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "applicationId", call: "callId", opening: "openingId" });
  await getCurrentUser();
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const status = String(formData.get("status") ?? "completed") as
    | "completed"
    | "failed"
    | "cancelled";
  const r = repo.finishCall({
    callId: String(formData.get("callId")),
    status,
    failureReason: String(formData.get("failureReason") ?? "").trim() || null,
  });
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  revalidatePath("/database");
  const msg = !r.ok
    ? r.message
    : status !== "completed"
      ? "Call closed. Nothing was written."
      : r.applied.length
        ? `Written to their record: ${r.applied.join(", ")}.${r.conflicts ? ` ${r.conflicts} answer${r.conflicts === 1 ? "" : "s"} disagreed with what was on file and ${r.conflicts === 1 ? "was" : "were"} left for you.` : ""}`
        : "Call closed. Nothing new to write — the record already held it.";
  redirect(`/openings/${openingId}/candidate/${appId}?msg=${encodeURIComponent(msg)}`);
}

// ─── The end-of-day email, and the reply that moves people ───────────────────
//
// One flow, not two. The set goes out on the email the desk already sends; the
// reply that comes back is what moves people. There is no separate review step
// and no second screen — the round is opened by pressing Send and closed by the
// reply landing.

/**
 * People an end-of-day send has taken and not yet recorded (2 Oct). The "already
 * sent" check read the recorded rounds, and the round is recorded only after the
 * email has gone — so two TAs, or a double click, passed the check together and both
 * emailed the Director the same candidates. A person is reserved here, in the same
 * synchronous step as the check, and released when the send ends. The site runs as
 * one process, so this is enough; a second server would need the claim in the database.
 */
const eodInFlight = new Set<string>();

/** Read the saved work type in preflight; an editable form must not waive tasks. */
async function eodResearchSubmission(user: User, openingId: string, kind: "director" | "client", formData: FormData, revised = false) {
  const link = String(formData.get("chatgptLink") ?? "");
  const confirmed = formData.get("researchConfirmed") === "on";
  let workType: WorkingStage = repo.workingStage(openingId, user.id);
  let excused = false;
  // Corrections belong to their saved submission, not today's attendance.
  if (revised) return checkResearchSubmission({ role: user.role, kind, link, confirmed, workType });
  if (kind === "director" && isConvex()) {
    try {
      const check = await convexMutation<{ ok: boolean; blockers: string[]; workType: WorkingStage }>("ta/workdays:emailPreflight", {
        actorId: user.id,
        jobId: openingId,
        workLocationId: String(formData.get("workLocationId") ?? "") || undefined,
        link,
        confirmed,
        revised,
      });
      if (!check.ok) return { ok: false as const, reason: check.blockers.join("; ") };
      workType = check.workType;
      excused = await convexQuery<boolean>("ta/workdays:researchExceptionAllowed", { actorId: user.id, jobId: openingId });
    } catch (error) {
      return { ok: false as const, reason: backendMessage(error, "Could not check the requirements. Try again.") };
    }
  }
  return checkResearchSubmission({ role: user.role, kind, link, confirmed, workType, excused });
}

async function eodWorkContext(user: User, openingId: string): Promise<{ workType: WorkingStage; sessionStart: number | null }> {
  if (isConvex() && isTa(user)) {
    return convexQuery<{ workType: WorkingStage; sessionStart: number | null }>("ta/workdays:eodContext", {
      actorId: user.id,
      jobId: openingId,
    });
  }
  return { workType: repo.workingStage(openingId, user.id), sessionStart: colomboDayStart(Date.now()) };
}

function refereeCallsFromForm(formData: FormData, calls: RefereeCallEmailRow[]): RefereeCallEmailRow[] {
  if (formData.get("includeRefereeCalls") === "no") return [];
  let moved: Record<string, unknown> = {};
  try {
    const raw = String(formData.get("refereeCallResults") ?? "");
    if (raw.length > 20_000) throw new Error("too large");
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) moved = parsed;
  } catch {
    moved = {};
  }
  return calls.map((call) => {
    const override = call.id ? moved[call.id] : undefined;
    return { ...call, result: override === "positive" || override === "negative" ? override : call.result };
  });
}

async function currentRefereeCalls(
  formData: FormData,
  openingId: string,
  userId: string,
  workLocationId?: string,
  saved?: RefereeCallEmailRow[],
): Promise<RefereeCallEmailRow[]> {
  const { resultOf } = await import("@/lib/refereeCalls");
  const { workdayDate } = await import("@/lib/workday");
  const base = saved ?? repo.refereeCalls(openingId, { userId, date: workdayDate(Date.now()), workLocationId }).map((call) => ({
    id: call.id,
    company: call.company,
    referral: call.referral,
    contactNumber: call.contactNumber ?? "",
    feedback: call.feedback,
    result: resultOf(call),
  }));
  return refereeCallsFromForm(formData, base);
}

type RefereeCallActionResult = ActionResult & { call?: RefereeCall };

const refereeText = (formData: FormData, field: string, max: number): string => {
  const value = String(formData.get(field) ?? "").trim();
  if (value.length > max) throw new Error(`${field === "contactNumber" ? "Contact number" : field[0].toUpperCase() + field.slice(1)} is too long.`);
  return value;
};

/**
 * Save on the Referee Calls sheet (23 Oct): every row the TA added, changed or
 * cleared since the last save, in one write. A TA writes only their own rows;
 * desk-wide seats read the page.
 */
export async function saveRefereeCalls(formData: FormData): Promise<ActionResult & { calls?: RefereeCall[] }> {
  let calls: RefereeCall[] | undefined;
  const result = await inline(async () => {
    const openingId = String(formData.get("openingId") ?? "");
    await primeStore({ openingId });
    const user = await authorize(formData, "opening.act", { opening: "openingId" });
    if (!isTa(user)) await fail("Referee calls are entered by the TA working the opening.");
    const opening = repo.opening(openingId);
    if (!opening) return fail("That opening no longer exists.");
    const location = requireWorkLocation(opening, String(formData.get("workLocationId") ?? "") || undefined);
    const { workdayDate } = await import("@/lib/workday");
    const { FIELD_MAX, GRID_FIELDS, MAX_GRID_ROWS, isBlankRow } = await import("@/lib/refereeGrid");
    const date = workdayDate(Date.now());
    if (String(formData.get("day") ?? date) !== date) await fail("Only today's calls can be changed. Open today in Work day.");

    const raw = String(formData.get("changes") ?? "");
    if (raw.length > 400_000) await fail(`That is too much to save at once — save at most ${MAX_GRID_ROWS} rows at a time.`);
    let parsed: { add?: unknown; update?: unknown; remove?: unknown };
    try { parsed = JSON.parse(raw || "{}"); } catch { return fail("The changes could not be read. Reload the page and try again."); }
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const clean = (row: Record<string, unknown>) => {
      const out = {} as Record<(typeof GRID_FIELDS)[number], string>;
      for (const f of GRID_FIELDS) {
        const value = String(row[f] ?? "").trim();
        const label = f === "contactNumber" ? "Contact number" : f[0].toUpperCase() + f.slice(1);
        if (value.length > FIELD_MAX[f]) throw new Error(`${label} is too long (at most ${FIELD_MAX[f]} characters).`);
        out[f] = value;
      }
      return out;
    };
    const add = list(parsed.add).map((r) => clean(r as Record<string, unknown>)).filter((r) => !isBlankRow(r));
    const update = list(parsed.update).map((r) => ({ id: String((r as { id?: unknown }).id ?? ""), ...clean(r as Record<string, unknown>) }));
    const remove = list(parsed.remove).map(String);
    if (add.length + update.length > MAX_GRID_ROWS) await fail(`Save at most ${MAX_GRID_ROWS} rows at a time.`);
    for (const id of [...update.map((u) => u.id), ...remove]) {
      const held = repo.refereeCall(id);
      if (!held || held.openingId !== openingId) await fail("One of these calls no longer exists. Reload the page.");
      if (held!.addedBy !== user.id) await fail("Only the TA who logged a call can change it.");
    }

    if (add.length || update.length || remove.length) {
      repo.saveRefereeCalls(
        { openingId, addedBy: user.id, date, ...(location ? { workLocationId: location.id } : {}) },
        { add, update, remove },
      );
      revalidatePath(`/openings/${openingId}`, "layout");
    }
    calls = repo.refereeCalls(openingId, { userId: user.id, date, workLocationId: location?.id ?? "" });
    await done("Saved.");
  }, "Saved.");
  return { ...result, ...(result.ok && calls ? { calls } : {}) };
}

export async function updateRefereeCall(formData: FormData): Promise<RefereeCallActionResult> {
  let call: RefereeCall | undefined;
  const result = await inline(async () => {
    const openingId = String(formData.get("openingId") ?? "");
    const callId = String(formData.get("callId") ?? "");
    await primeStore({ openingId });
    const user = await authorize(formData, "opening.act", { opening: "openingId" });
    const held = repo.refereeCall(callId);
    if (!held || held.openingId !== openingId) return fail("That referee call no longer exists.");
    if (!isTa(user) || held.addedBy !== user.id) await fail("Only the TA who logged this call can change it.");
    const field = String(formData.get("field") ?? "") as "company" | "referral" | "contactNumber" | "feedback" | "result";
    if (!["company", "referral", "contactNumber", "feedback", "result"].includes(field)) await fail("That referee call field cannot be changed.");
    if (field === "result") {
      const value = String(formData.get("value") ?? "");
      if (value !== "positive" && value !== "negative") return fail("Choose Positive or Not successful.");
      call = repo.updateRefereeCall(callId, { result: value }) ?? undefined;
    } else {
      const max = field === "feedback" ? 2000 : field === "contactNumber" ? 100 : 200;
      call = repo.updateRefereeCall(callId, { [field]: refereeText(formData, "value", max) }) ?? undefined;
    }
    if (!call) await fail("That referee call no longer exists.");
    revalidatePath(`/openings/${openingId}`, "layout");
    await done("Saved.");
  }, "Saved.");
  return { ...result, ...(result.ok && call ? { call } : {}) };
}

export async function addMiddayEmail(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  let id: string;
  try {
    id = await convexMutation<string>("ta/dailyEmails:createDraft", { actorId: user.id, jobId: openingId, workLocationId: String(formData.get("workLocationId") ?? "") || undefined });
  } catch (e) { return fail(backendMessage(e, "Could not create the midday email.")); }
  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(`/openings/${openingId}/midday?mail=${id}&location=${encodeURIComponent(String(formData.get("workLocationId") ?? ""))}`);
}

export async function saveMiddayDraft(openingId: string, id: string, revision: number, fields: Record<string, string>) {
  await primeStore({ openingId });
  const form = new FormData();
  form.set("openingId", openingId);
  const user = await authorize(form, "opening.act", { opening: "openingId" });
  try {
    const result = await convexMutation<{ revision: number }>("ta/dailyEmails:saveDraft", { actorId: user.id, id, revision, fields });
    return { ok: true as const, revision: result.revision };
  } catch (e) { return { ok: false as const, message: backendMessage(e, "Could not save the draft.") }; }
}

export async function reconcileDailyEmail(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  try {
    await convexMutation("ta/dailyEmails:reconcile", { actorId: user.id, id: String(formData.get("dailyEmailId")),
      accepted: formData.get("accepted") === "yes", reason: String(formData.get("reason") ?? "") });
  } catch (e) { return fail(backendMessage(e, "Could not reconcile this email.")); }
  revalidatePath(`/openings/${openingId}`, "layout");
  return back("Email result reconciled.");
}

/** Both daily submissions share the same durable reservation and transport. */
export async function sendDailyEmail(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  const type: SubmissionType = formData.get("submissionType") === "midday" ? "midday" : "eod";
  const draftId = String(formData.get("dailyDraftId") ?? "");
  const parentId = String(formData.get("dailyParentId") ?? "");
  // Set only when sending a past day's end of day late; the server re-checks the day and the list.
  const forDate = String(formData.get("forDate") ?? "") || undefined;
  let workLocationId = String(formData.get("workLocationId") ?? "") || undefined;
  await primeStore({ openingId, allApplications: true });
  const user = await authorize(formData, parentId ? "opening.read" : "opening.act", { opening: "openingId" });
  const permission = can(user, "opening.act", { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null });
  if (!permission.ok) return fail(permission.message);
  const baseUrl = `/openings/${openingId}/${type === "midday" ? "midday" : "eod"}`;
  let message = "";
  let sentId = "";
  try {
    const { shortlistRows, shortlistRowsFromForm, effortFromForm, effortRow } = await import("@/lib/eod");
    const { revisedSubject, validateResearchLink } = await import("@/lib/eod-format");
    const emails = await convexQuery<DailyEmail[]>("ta/dailyEmails:list", { actorId: user.id, jobId: openingId });
    const parent = parentId ? emails.find(e => e._id === parentId && e.userId === user.id && e.submissionType === "eod" && e.status === "accepted") : undefined;
    if (parentId && !parent?.snapshot) throw new Error("That original EOD email is no longer available to correct.");
    if (parent) workLocationId = parent.workLocationId;
    else workLocationId = requireWorkLocation(repo.opening(openingId)!, workLocationId)?.id;
    if (parent && formData.get("previewConfirmed") !== "on") throw new Error("Review and confirm the revised email preview before sending.");
    const context = parent ? null : forDate ? { workType: "100%" as WorkingStage, sessionStart: null } : await eodWorkContext(user, openingId);
    const baseRows = parent?.snapshot?.rows ?? shortlistRows(openingId, isTa(user) ? user.id : null, "director", context ? { ...context, day: forDate } : undefined, workLocationId);
    const ids = parent ? parent.applicationIds : String(formData.get("applicationIds") ?? "").split(",").filter(Boolean);
    const rows = shortlistRowsFromForm(formData, baseRows);
    const effort = effortFromForm(formData, parent?.snapshot?.effort ?? effortRow(openingId, user, forDate ? new Date(`${forDate}T12:00:00+05:30`) : new Date(), workLocationId, forDate ? baseRows.map(r => r.applicationId) : undefined));
    const refereeCalls = type === "eod" && !forDate
      ? await currentRefereeCalls(formData, openingId, user.id, workLocationId, parent?.snapshot?.refereeCalls)
      : [];
    const submittedMode = parent?.workType ?? parent?.snapshot?.workType ?? context?.workType;
    if (submittedMode) effort.hundredOrFollowUp = submittedMode;
    const extraTo = parseAddressList(String(formData.get("extraTo") ?? ""));
    const extraCc = parseAddressList(String(formData.get("extraCc") ?? ""));
    if (extraTo.bad.length || extraCc.bad.length) throw new Error("Correct the invalid To or Cc email addresses.");
    const removed = parseAddressList(String(formData.get("removed") ?? "")).ok;
    const recipients = eodRecipients({ removed, extraTo: extraTo.ok, extraCc: extraCc.ok, shortlistInbox: repo.shortlistInbox() });
    if (parent?.snapshot) {
      const off = new Set(removed.map(a => a.toLowerCase()));
      recipients.to = [...new Set([parent.snapshot.to[0], ...extraTo.ok].filter(a => a && !off.has(a.toLowerCase())))];
      recipients.cc = [...new Set([...parent.snapshot.cc, ...extraCc.ok].filter(a => !off.has(a.toLowerCase()) && !recipients.to.includes(a)))];
    }
    if (!recipients.to.length) throw new Error("Add an address on the To line.");
    const confirmed = formData.get("researchConfirmed") === "on";
    // Midday always carries fresh research. EOD keeps the server-authoritative
    // work type and exception rules already used by the live send path.
    const research = type === "midday" || parent || forDate
      ? checkResearchSubmission({ role: "ta", kind: "director", link: String(formData.get("chatgptLink") ?? ""), confirmed })
      : await eodResearchSubmission(user, openingId, "director", formData, !!parentId);
    if (!research.ok) throw new Error(research.reason);
    const rawSubject = String(formData.get("subject") ?? "").trim();
    const subject = parent ? revisedSubject(rawSubject) : rawSubject;
    const skipAttachments = formData.get("skipAttachments") === "yes";
    const result = await emailEod({ openingId, user, workLocationId, applicationIds: ids, to: recipients.to[0], extraTo: recipients.to.slice(1),
      cc: recipients.cc, subject, effort, rows, baseRows, researchLink: research.url,
      refereeCalls,
      introText: String(formData.get("introText") ?? ""), outroText: String(formData.get("outroText") ?? ""),
      activityOnly: ids.length === 0, skipAttachments: type === "midday" && skipAttachments, daily: { submissionType: type, draftId: draftId || undefined,
        revision: draftId ? Number(formData.get("dailyDraftRevision")) : undefined, parentId: parentId || undefined, forDate,
        extraTo: extraTo.ok, extraCc: extraCc.ok, removed, confirmed },
      savedAttachments: parent?.snapshot?.attachments,
      regenerateAttachments: formData.get("regenerateAttachments") === "yes",
      workType: submittedMode,
    });
    if (!result.ok) throw new Error(result.error);
    sentId = result.dailyEmailId ?? "";
    message = result.note;
    // Mail is already recorded atomically. Failure to update an edited profile
    // must not invite a second send.
    try { message += await saveEodEdits(rows, baseRows, ids); }
    catch { message += " Email sent; profile edits could not be saved. Review the candidate records."; }
    await afterBackendWrite(openingId);
  } catch (e) {
    message = sentId ? "Email sent and recorded. Reload to see its saved copy." : backendMessage(e, "Could not send the email. Check its status before retrying.");
  }
  revalidatePath(`/openings/${openingId}`, "layout");
  const mail = sentId || draftId || parentId;
  redirect(`${baseUrl}?${workLocationId ? `location=${encodeURIComponent(workLocationId)}&` : ""}${mail ? `mail=${encodeURIComponent(mail)}&` : ""}${sentId ? `sent=${encodeURIComponent(sentId)}&` : ""}msg=${encodeURIComponent(message)}`);
}

export async function sendEod(formData: FormData) {
  if (isConvex() && (formData.get("kind") ?? "director") === "director") return sendDailyEmail(formData);
  const openingId = String(formData.get("openingId"));
  const kind = String(formData.get("kind") ?? "director") as "director" | "client";
  await primeStore({ openingId, allApplications: true });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const location = requireWorkLocation(repo.opening(openingId)!, String(formData.get("workLocationId") ?? ""));
  const ids = String(formData.get("applicationIds") ?? "").split(",").filter(Boolean);
  const context = kind === "director" ? await eodWorkContext(user, openingId) : null;
  const activityOnly = kind === "director" && formData.get("activityOnly") === "yes" && ids.length === 0;
  if (activityOnly) {
    const { shortlistRows } = await import("@/lib/eod");
    if (shortlistRows(openingId, isTa(user) ? user.id : null, "director", context ?? undefined).length) await fail("Candidates are ready for Director Review. Reload and include them in the email.");
  }

  // Anybody already sent to this reviewer is dropped, and so is anybody who is
  // not on this opening — the list came from the browser.
  const sent = new Set(repo.reviewRounds(openingId).filter((r) => r.kind === kind && !r.recoveryReopenedAt).flatMap((r) => r.applicationIds));
  const holdKey = (id: string) => `${openingId}:${kind}:${id}`;
  // A TA sends only the people they shortlisted on this opening (the desk, 2 Oct): the list
  // came from the browser, so it is checked here, not only when the page is drawn. A lead or
  // director sends for the desk.
  const mine = (id: string) => !isTa(user) || repo.application(id)?.ownerTaId === user.id;
  const notMine = ids.filter((id) => !mine(id));
  const fresh = ids.filter((id) => {
    const app = repo.application(id);
    if (!app) return false;
    return mine(id) && inWorkLocation(app, location?.id) && !sent.has(id) && !eodInFlight.has(holdKey(id)) && app.openingId === openingId && (
      kind !== "director" || !context || isEodCandidateEligible({
        stage: app.stage,
        ownerTaId: app.ownerTaId,
        isAddOn: app.isAddOn,
        lastStageChangedAt: app.lastStageChangedAt,
      }, { taId: isTa(user) ? user.id : null, ...context })
    );
  });
  if (notMine.length > 0 && fresh.length === 0)
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent("Nothing sent — you can send only the candidates you shortlisted.")}`);
  if (fresh.length === 0 && !activityOnly)
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(
      ids.length ? "Everyone on that list has already been sent, or is being sent right now." : "Nothing to send.",
    )}`);
  for (const id of fresh) eodInFlight.add(holdKey(id));
  try {
  const sets = fresh.map((id) => repo.application(id)?.setNumber).filter((n): n is number => n != null);
  const roundToken = makeReviewToken();
  // Recipients see the normal subject. The token identifies the stored round
  // internally; Microsoft 365's hidden thread headers match the reply.
  const trackedSubject = String(formData.get("subject") ?? "").trim();

  // The desk's To and Cc start on it; the TA can add more (29 Sep) and take any
  // off, the desk's own included (1 Oct). An address that is not one stops the
  // send, so nobody is quietly left off.
  const toList = parseAddressList(String(formData.get("extraTo") ?? ""));
  const ccList = parseAddressList(String(formData.get("extraCc") ?? ""));
  const badAddress = [...toList.bad, ...ccList.bad];
  if (kind === "director" && badAddress.length)
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(
      `Not sent: ${badAddress.join(", ")} ${badAddress.length === 1 ? "is not an email address" : "are not email addresses"}.`,
    )}`);
  const recipients = eodRecipients({
    removed: parseAddressList(String(formData.get("removed") ?? "")).ok,
    extraTo: toList.ok,
    extraCc: ccList.ok,
    shortlistInbox: repo.shortlistInbox(),
  });
  if (kind === "director" && recipients.to.length === 0)
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(
      "Not sent: nobody is on the To line. Add an address as To.",
    )}`);
  const research = await eodResearchSubmission(user, openingId, kind, formData);
  if (!research.ok)
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(`Not sent: ${research.reason}`)}`);
  const sentTo = kind === "director" ? recipients.to[0] : String(formData.get("to") ?? "");

  // The Director's copy is really sent now, through Microsoft Graph from the
  // TA's own mailbox, copying the TA Lead, the desk's end-of-day copy and the
  // shortlist inbox. Nothing is recorded unless it went. The client's copy is
  // still sent by operations and only recorded here.
  let sentNote = "";
  // What went, kept a month to read back, correct and send again (8 Oct). Saved
  // once the round is open, since the copy belongs to it.
  let copy: Omit<EodEmailCopy, "id" | "roundId" | "sentAt" | "expiresAt"> | null = null;
  let workdayMailId: string | null = null;
  if (kind === "director") {
    const { effortFromForm, effortRow, shortlistRowsFromForm, shortlistRows } = await import("@/lib/eod");
    const effort = effortFromForm(formData, effortRow(openingId, user));
    const baseRows = shortlistRows(openingId, isTa(user) ? user.id : null, "director", context ?? undefined);
    const editedRows = shortlistRowsFromForm(formData, baseRows);
    const refereeCalls = await currentRefereeCalls(formData, openingId, user.id, location?.id);
    const introText = formData.has("introText") ? String(formData.get("introText")) : undefined;
    const outroText = formData.has("outroText") ? String(formData.get("outroText")) : undefined;

    if (effort.hundredOrFollowUp && ["100%", "Follow-up", "Add-on"].includes(effort.hundredOrFollowUp)) {
      if (isConvex()) {
        try {
          await convexMutation("ta/openings:setWorkingStage", {
            actorId: user.id,
            openingId,
            stage: effort.hundredOrFollowUp as WorkingStage,
          });
        } catch (e) {
          // The email still goes; the working stage is only a label on it.
          console.warn("[eod] working stage not saved:", backendMessage(e, "refused"));
        }
      } else {
        repo.setWorkingStage(openingId, user.id, effort.hundredOrFollowUp as WorkingStage);
      }
    }
    const r = await emailEod({
      openingId,
      user,
      applicationIds: fresh,
      to: sentTo,
      extraTo: recipients.to.slice(1),
      cc: recipients.cc,
      subject: trackedSubject,
      // The counts and targets as the TA corrected them (plan 6.3).
      effort,
      rows: editedRows,
      refereeCalls,
      baseRows,
      introText,
      outroText,
      researchLink: research.url,
      activityOnly,
    });
    if (!r.ok) redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(`Not sent: ${r.error}`)}`);
    workdayMailId = r.workdayMailId ?? null;
    sentNote = r.note + (await saveEodEdits(editedRows, baseRows, fresh));

    const sentRows = fresh.flatMap((id, i) => {
      const row = editedRows.find((e) => e.applicationId === id);
      return row ? [{ ...row, no: i + 1 }] : [];
    });
    copy = {
      openingId,
      version: 1,
      sentBy: user.id,
      subject: trackedSubject,
      introText: introText ?? "",
      outroText: outroText ?? "",
      researchLink: research.url,
      applicationIds: fresh,
      rows: sentRows,
      effort,
      refereeCalls,
      extraTo: toList.ok,
      extraCc: ccList.ok,
      removed: parseAddressList(String(formData.get("removed") ?? "")).ok,
      to: recipients.to,
      cc: recipients.cc,
    };
  }

  // Anyone sent to the Director straight out of a finished follow-up moves to
  // Director Review now — the email going out is that move.
  const notMoved: string[] = [];
  if (kind === "director") {
    for (const id of fresh) {
      const st = repo.application(id)?.stage;
      if (st === "ai_follow_up" || st === "ta_follow_up" || (st as string) === "follow_up") {
        // Through the backend's own move on Convex, so its stage counts, its
        // history and the stop of the follow-up sequence happen too — the
        // store's write skipped all three (plan 3.2, 21 Sep).
        if (isConvex()) {
          await backend
            .moveStage({ id: user.id }, id, "director_review", "Sent to the Director in the end-of-day email")
            .catch((e) => {
              console.warn(`[eod] ${id} stays in Follow-up: ${backendMessage(e, "move refused")}`);
              // The email has gone, so they were sent; the TA is told they
              // did not move, instead of reading them as waiting on the
              // Director (review of PR #2, 21 Sep).
              notMoved.push(repo.candidate(repo.application(id)?.candidateId ?? "")?.fullName ?? "one person");
            });
        } else {
          repo.moveStage(id, "director_review", user.id, "Sent to the Director in the end-of-day email");
        }
      }
    }
    if (isConvex()) await afterBackendWrite(openingId);
  }

  const round = repo.openReviewRound({
    openingId,
    workLocationId: location?.id,
    workLocationName: location?.name,
    kind,
    applicationIds: fresh,
    setNumber: sets.length ? Math.min(...sets) : null,
    sentBy: user.id,
    sentTo,
    // The address the reply is watched on: copied in, and on the reply-to.
    trackedAt: repo.shortlistInbox(),
    subject: trackedSubject,
    token: roundToken,
    researchLink: research.url,
    dispatch: kind === "director" ? "sent" : "held",
  });
  if (copy) {
    try {
      repo.saveEodCopy({ ...copy, roundId: round.id });
    } catch (e) {
      // The email has gone and the round is open; only the copy to resend is missing.
      console.warn("[eod] copy not kept:", (e as Error).message);
      sentNote += " A copy to correct and send again could not be kept.";
    }
  }

  if (workdayMailId) await convexMutation("ta/workdays:finalizeMail", { actorId: user.id, id: workdayMailId });

  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(
    `/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(
      kind === "director"
        ? activityOnly ? `${sentNote} Activity summary sent; no candidate submissions.` : `${sentNote} ${fresh.length} ${fresh.length === 1 ? "person is" : "people are"} now waiting on the Director's reply.${
            notMoved.length ? ` Still in Follow-up — move by hand: ${notMoved.join(", ")}.` : ""
          }`
        : `Recorded as sent to the client. ${fresh.length} ${fresh.length === 1 ? "person is" : "people are"} now waiting on a reply. Nothing was emailed from here.`,
    )}`,
  );
  } finally {
    for (const id of fresh) eodInFlight.delete(holdKey(id));
  }
}

/**
 * Send a Director's end-of-day email again, corrected (8 Oct).
 *
 * The TA Lead or a Director asks for a change; the email itself cannot be
 * edited once it has gone, so the TA corrects the copy kept for the month and
 * sends it again, "REVISED - " in front of the subject. Same people in the same
 * order, so the reply's numbers still mean what they meant: no new round, no
 * stage moves, no set numbers change — only the email goes again. From the
 * sender's own mailbox, so only the sender can.
 */
export async function resendEod(formData: FormData) {
  const openingId = String(formData.get("openingId"));
  const copyId = String(formData.get("copyId") ?? "");
  await primeStore({ openingId, allApplications: true });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const done = (message: string): never =>
    redirect(`/openings/${openingId}/eod?kind=director&msg=${encodeURIComponent(message)}`);

  const prev = repo.eodCopy(copyId);
  if (!prev || prev.openingId !== openingId) return done("Not sent: that email is more than a month old, so its copy has been cleared.");
  if (prev.sentBy !== user.id)
    return done("Not sent: only the person who sent this email can send it again — it goes from their own mailbox.");
  const versions = repo.eodCopies(openingId).filter((c) => c.roundId === prev.roundId);
  const version = Math.max(prev.version, ...versions.map((c) => c.version)) + 1;

  const hold = `${openingId}:resend:${prev.roundId}`;
  if (eodInFlight.has(hold)) return done("It is being sent again right now.");
  eodInFlight.add(hold);
  try {
    const toList = parseAddressList(String(formData.get("extraTo") ?? ""));
    const ccList = parseAddressList(String(formData.get("extraCc") ?? ""));
    const badAddress = [...toList.bad, ...ccList.bad];
    if (badAddress.length)
      return done(`Not sent: ${badAddress.join(", ")} ${badAddress.length === 1 ? "is not an email address" : "are not email addresses"}.`);
    const removed = parseAddressList(String(formData.get("removed") ?? "")).ok;
    const recipients = eodRecipients({ removed, extraTo: toList.ok, extraCc: ccList.ok, shortlistInbox: repo.shortlistInbox() });
    if (recipients.to.length === 0) return done("Not sent: nobody is on the To line. Add an address as To.");
    const research = await eodResearchSubmission(user, openingId, "director", formData, true);
    if (!research.ok) return done(`Not sent: ${research.reason}`);
    const typed = String(formData.get("subject") ?? "").trim();
    if (!typed) return done("Not sent: the email needs a subject.");

    const { effortFromForm, shortlistRowsFromForm, rowsForApplications } = await import("@/lib/eod");
    const { revisedSubject } = await import("@/lib/eod-format");
    // The people as they went, never a list from the browser.
    const baseRows = rowsForApplications(prev.applicationIds);
    if (baseRows.length === 0) return done("Not sent: nobody from that email is on this opening any more.");
    const ids = baseRows.map((r) => r.applicationId);
    const editedRows = shortlistRowsFromForm(formData, baseRows);
    // The composer opens on the copy as sent, so a change is measured against
    // that copy. Measured against today's record, every salary or notice updated
    // since the first send was put back to the month-old value (review, 8 Oct).
    const sentRows = baseRows.map((b) => prev.rows.find((r) => r.applicationId === b.applicationId) ?? b);
    const effort = effortFromForm(formData, prev.effort);
    const refereeCalls = await currentRefereeCalls(formData, openingId, user.id, undefined, prev.refereeCalls);
    const subject = revisedSubject(typed);
    const introText = formData.has("introText") ? String(formData.get("introText")) : prev.introText;
    const outroText = formData.has("outroText") ? String(formData.get("outroText")) : prev.outroText;

    const r = await emailEod({
      openingId,
      user,
      applicationIds: ids,
      to: recipients.to[0],
      extraTo: recipients.to.slice(1),
      cc: recipients.cc,
      subject,
      effort,
      refereeCalls,
      rows: editedRows,
      baseRows: sentRows,
      revised: true,
      activityOnly: ids.length === 0,
      introText,
      outroText,
      researchLink: research.url,
    });
    if (!r.ok) return done(`Not sent: ${r.error}`);
    let note = r.note + (await saveEodEdits(editedRows, sentRows, ids));

    try {
      repo.saveEodCopy({
        openingId,
        roundId: prev.roundId,
        version,
        sentBy: user.id,
        // Every revised version has its own month of retention.
        expiresAt: Date.now() + 31 * 86400000,
        subject,
        introText,
        outroText,
        researchLink: research.url,
        applicationIds: ids,
        rows: editedRows,
        effort,
        refereeCalls,
        extraTo: toList.ok,
        extraCc: ccList.ok,
        removed,
        to: recipients.to,
        cc: recipients.cc,
      });
      repo.markRoundRevised(prev.roundId, { researchLink: research.url });
    } catch (e) {
      console.warn("[eod] resent copy not kept:", (e as Error).message);
      note += " This version could not be kept to send again.";
    }

    revalidatePath(`/openings/${openingId}`, "layout");
    return done(`Sent again, marked REVISED. ${note} The Director's reply is still read against the same set.`);
  } finally {
    eodInFlight.delete(hold);
  }
}

/**
 * What the TA corrected on the email goes onto the candidate too, so their
 * CV's box, profile and Director review read the same (the desk, 29 Sep).
 * Only after it went, and a detail that cannot be saved does not undo the
 * send — it is said, in the line this returns.
 */
async function saveEodEdits(editedRows: ShortlistRow[], baseRows: ShortlistRow[], ids: string[]): Promise<string> {
  const { eodDetailChanges } = await import("@/lib/eod");
  let unsaved = 0;
  for (const edited of editedRows) {
    if (!ids.includes(edited.applicationId)) continue;
    const base = baseRows.find((b) => b.applicationId === edited.applicationId);
    const app = repo.application(edited.applicationId);
    const change = base && app ? eodDetailChanges(base, edited) : null;
    if (!change || !app) continue;
    try {
      repo.saveReviewDetails(app.id, app.candidateId, change.notes, change.patch);
      invalidateCandidate(app.candidateId);
    } catch (e) {
      unsaved++;
      console.warn("[eod] details not saved to the candidate:", (e as Error).message);
    }
  }
  return unsaved
    ? ` ${unsaved === 1 ? "One candidate's" : `${unsaved} candidates'`} edited details could not be saved to their record — check them on their page.`
    : "";
}

/**
 * Send the Director's end-of-day email through Microsoft Graph (convex/ta/eodMail.ts).
 *
 * The same email the composer shows: the shortlist table for exactly these
 * people in this order, today's L-sheet line, and each prepared CV attached.
 */
async function emailEod(input: {
  openingId: string;
  workLocationId?: string;
  user: User;
  applicationIds: string[];
  to: string;
  /** More To beside `to`, and the whole Cc line, as the TA left them (lib/eod-format eodRecipients). */
  extraTo?: string[];
  cc: string[];
  subject: string;
  effort?: EffortRow;
  refereeCalls?: RefereeCallEmailRow[];
  rows?: ShortlistRow[];
  /** The rows as built from the records, before the TA's edits. A resend passes
   *  its own: shortlistRows no longer lists people already in a round. */
  baseRows?: ShortlistRow[];
  introText?: string;
  outroText?: string;
  researchLink?: string | null;
  activityOnly?: boolean;
  revised?: boolean;
  skipAttachments?: boolean;
  savedAttachments?: import("@/lib/dailyEmail").SavedEmailAttachment[];
  regenerateAttachments?: boolean;
  workType?: WorkingStage;
  daily?: { submissionType: SubmissionType; draftId?: string; revision?: number; parentId?: string; forDate?: string; extraTo: string[]; extraCc: string[]; removed: string[]; confirmed: boolean };
}): Promise<{ ok: true; note: string; workdayMailId?: string | null; dailyEmailId?: string } | { ok: false; error: string }> {
  const { openingId, user } = input;
  if (!input.applicationIds.length && !input.activityOnly) return { ok: false, error: "Include at least one CV or send an activity summary." };
  const opening = repo.opening(openingId);
  if (!opening) return { ok: false, error: "That opening no longer exists." };
  const to = input.to.trim() || EOD_TO;
  if (!input.subject.trim()) return { ok: false, error: "The email needs a subject." };

  const candidateIds = input.applicationIds
    .map((id) => repo.application(id)?.candidateId)
    .filter((c): c is string => !!c);
  await primeStore({ openingId, candidateIds });

  const { shortlistRows, shortlistRowFor, effortRow } = await import("@/lib/eod");
  const { eodEmailHtml } = await import("@/lib/eod-format");
  const { preparedCvFileName } = await import("@/lib/pdf");

  // The rows as built from the records, before the TA's edits on the page.
  const baseRows = input.baseRows ?? shortlistRows(openingId, null, "director");
  // The rows for exactly the people being sent, numbered in the order sent —
  // the order the Director's reply numbers refer to.
  const byId = new Map((input.rows ?? baseRows).map((r) => [r.applicationId, r]));
  const baseById = new Map(baseRows.map((r) => [r.applicationId, r]));
  const rows = input.applicationIds
    .map((id, i) => {
      const existing = byId.get(id);
      if (existing) return { ...existing, no: i + 1 };
      const a = repo.application(id);
      const c = a ? repo.candidate(a.candidateId) : null;
      return a && c ? shortlistRowFor(a, c, i + 1) : null;
    })
    .filter((r): r is NonNullable<typeof r> => !!r);

  if (rows.length === 0 && !input.activityOnly) return { ok: false, error: "Nobody on that list is ready to send." };

  const isMidday = input.daily?.submissionType === "midday";
  const attachments: { name: string; contentType: string; base64: string }[] = [];
  const savedAttachments: import("@/lib/dailyEmail").SavedEmailAttachment[] = [];
  const preparationFailures: string[] = [];
  if (!input.skipAttachments) {
    for (const r of rows) {
      const saved = !input.regenerateAttachments && input.savedAttachments?.find(a => a.applicationId === r.applicationId);
      if (saved && input.daily?.parentId) {
        try {
          const file = await convexQuery<{ url: string; name: string }>("ta/dailyEmails:attachment", { actorId: user.id, emailId: input.daily.parentId, attachmentId: saved.id });
          const response = await fetch(internalUploadUrl(file.url), { cache: "no-store" });
          if (!response.ok) throw new Error("Saved CV could not be read.");
          attachments.push({ name: file.name, contentType: "application/pdf", base64: Buffer.from(await response.arrayBuffer()).toString("base64") });
          savedAttachments.push(saved);
        } catch { preparationFailures.push(r.name); }
        continue;
      }
      const app = repo.application(r.applicationId);
      const c = app ? repo.candidate(app.candidateId) : null;
      if (!app || !c) { preparationFailures.push(r.name); continue; }
      try {
        // The same file as the drawer's Prepared CV (lib/preparedCvFile, 29 Sep):
        // what the desk holds, with the box where the TA put it — and whatever
        // the TA changed on this email, so the attachment says what the email
        // says. A field they did not touch comes from the record, so the table's
        // own "Not disclosed" for an unknown salary never reaches the CV.
        const { preparedCvFile } = await import("@/lib/preparedCvFile");
        const { boxContent } = await import("@/lib/preparedCv");
        const { boxOverrides, eodDetailChanges } = await import("@/lib/eod-format");
        const base = baseById.get(r.applicationId);
        const annotation = { ...boxContent(app, c, opening), ...(base ? boxOverrides(eodDetailChanges(base, r)) : {}) };
        const pdfBytes = (await preparedCvFile(app, c, opening, { annotation })).bytes;

        const base64 = Buffer.from(pdfBytes).toString("base64");
        const name = preparedCvFileName(c.fullName);
        if (input.daily) {
          const url = await convexMutation<string>("ta/cv:uploadUrl", { actorId: user.id });
          const uploaded = await fetch(internalUploadUrl(url), { method: "POST", headers: { "content-type": "application/pdf" }, body: Buffer.from(pdfBytes) });
          if (!uploaded.ok) throw new Error("The email's CV backup could not be stored.");
          const { storageId } = await uploaded.json();
          const id = await convexMutation<string>("ta/dailyEmails:saveAttachment", { actorId: user.id, jobId: openingId, applicationId: r.applicationId, storageId, name });
          savedAttachments.push({ id, name, applicationId: r.applicationId });
        }
        attachments.push({ name, contentType: "application/pdf", base64 });
      } catch (e) {
        console.error(`[End of day] CV for ${c.fullName} could not be prepared:`, (e as Error).message);
        preparationFailures.push(c.fullName);
      }
    }
  }

  // Midday emails can be sent without attachments (reasons explained in the email body).
  // EOD is all-or-nothing: preparation happens before the durable send
  // reservation, then Graph's draft/upload-session path carries every PDF.
  if (preparationFailures.length && !isMidday) return { ok: false, error: `Not sent: could not prepare the CV attachment for ${preparationFailures.join(", ")}. No candidates have been marked as sent.` };
  if (!rows.length && !input.activityOnly && !isMidday) return { ok: false, error: "No CV could be attached. Prepare at least one Director Review CV before sending the email." };

  let excelAttachment: import("@/lib/linkExport").ExcelExportAttachment | null = null;
  // Today's workbook is not a past day's; a late end of day goes without it.
  if (!isMidday && !input.daily?.forDate && !input.skipAttachments) {
    const { buildOpeningExcelAttachment } = await import("@/lib/linkExport");
    excelAttachment = buildOpeningExcelAttachment(openingId, user, opening.title, opening.workLocations?.length ? input.workLocationId ?? "" : undefined);
    if (excelAttachment && excelAttachment.rowCount > 0) {
      attachments.push({
        name: excelAttachment.filename,
        contentType: excelAttachment.contentType,
        base64: excelAttachment.base64,
      });
    }
  }

  const html = eodEmailHtml({
    rows,
    effort: input.effort ?? effortRow(openingId, user),
    senderName: user.name,
    introText: input.introText,
    outroText: input.outroText,
    researchLink: input.researchLink,
    refereeCalls: input.refereeCalls,
    attachmentNote: null,
  });

  let result:
    | { ok: true; from: string; to: string; alsoTo?: string[]; cc: string[]; note: string }
    | { ok: false; error: string };
  let workdayMailId: string | null = null;
  let dailyEmailId: string | undefined;
  try {
    if (input.daily) {
      const snapshot: DailyEmailSnapshot = { subject: input.subject.trim(), html, from: user.email,
        workbookLinkIds: excelAttachment?.linkIds,
        to: [to, ...(input.extraTo ?? [])], cc: input.cc, attachmentNames: attachments.map(a => a.name), rows,
        attachments: savedAttachments,
        workType: input.workType,
        effort: input.effort ?? effortRow(openingId, user), introText: input.introText ?? "", outroText: input.outroText ?? "",
        refereeCalls: input.refereeCalls,
        researchLink: input.researchLink ?? "", extraTo: input.daily.extraTo, extraCc: input.daily.extraCc, removed: input.daily.removed };
      const reservation = await convexMutation<{ id: string }>("ta/dailyEmails:begin", { actorId: user.id, jobId: openingId,
        workLocationId: input.workLocationId,
        submissionType: input.daily.submissionType, draftId: input.daily.draftId, revision: input.daily.revision,
        parentId: input.daily.parentId, forDate: input.daily.forDate, applicationIds: input.applicationIds, snapshot, confirmed: input.daily.confirmed, previewConfirmed: !!input.daily.parentId, trackedAt: repo.shortlistInbox() ?? undefined });
      dailyEmailId = reservation.id;
    } else if (!input.revised) {
      const receipt = await convexMutation<{ id: string | null }>("ta/workdays:beginMail", { actorId: user.id, jobId: openingId, applicationIds: input.applicationIds, subject: input.subject, sentTo: to, researchLink: input.researchLink ?? undefined });
      workdayMailId = receipt.id;
    }
    result = await convexAction("ta/eodMail:send", {
      from: user.email,
      to,
      alsoTo: input.extraTo ?? [],
      // The desk's list and the inbox that watches for the reply, less any the
      // TA took off, plus any they added (sendEod, 1 Oct).
      cc: input.cc,
      replyTo: [user.email, repo.shortlistInbox()].filter(Boolean),
      subject: input.subject.trim(),
      html,
      attachments,
      workdayMailId: workdayMailId ?? undefined,
      dailyEmailId,
    });
  } catch (e) {
    return { ok: false, error: backendMessage(e, "The email could not be sent.") };
  }
  if (!result.ok) return { ok: false, error: result.error };
  // Everyone it actually went to: the added To were left out of this line, so
  // it read as if only the first address got the email (1 Oct).
  const sentTo = [result.to, ...(result.alsoTo ?? [])].join(", ");
  const cvCount = rows.length;
  const attachmentSummaryParts = [
    cvCount > 0 ? `${cvCount} CV${cvCount === 1 ? "" : "s"}` : null,
    excelAttachment ? `1 Excel Tables workbook (${excelAttachment.rowCount} link${excelAttachment.rowCount === 1 ? "" : "s"})` : null,
  ].filter(Boolean);
  return {
    ok: true,
    workdayMailId,
    dailyEmailId,
    note: `Sent from ${result.from} to ${sentTo}${result.cc.length ? `, cc ${result.cc.join(", ")}` : ", no cc"}, with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}${attachmentSummaryParts.length ? ` (${attachmentSummaryParts.join(", ")})` : ""}.${result.note ? ` ${result.note.trim()}` : ""}`,
  };
}

/** Who every end-of-day email is copied to (azim@career141.com to start with). */
export async function setEodCopy(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const v = String(formData.get("eodCc") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)) await fail("That is not an email address.");
  repo.setSetting("eodCc", v);
  revalidatePath("/people");
  revalidatePath("/openings", "layout");
  await back(`End-of-day emails are now copied to ${v}.`);
}

/**
 * The reply comes back and people move.
 *
 * Read against exactly the people that went out, in the order they were
 * numbered in the email — which is why the round holds the list. A clean,
 * unambiguous parse is applied straight away, because that is the whole point
 * of tracking the reply. Anything the reader is not sure about is left alone
 * and said plainly, rather than moved on a guess.
 */
/**
 * Read a reply against everyone waiting on that reviewer for the opening, and
 * move whoever it decides. Shared by the paste box and the shared-inbox helper.
 */
async function readReplyFor(openingId: string, kind: "director" | "client", body: string, roundId?: string): Promise<string> {
  // A reply answers ONE email, and "2" means the second person in THAT email —
  // even after someone else in it was decided. Reading against everyone still
  // waiting renumbered the list, so a partial earlier reply made "Shortlist 2"
  // pick the original number 3 (13 September review). Earlier emails are not
  // folded in: their people were never numbered in this one.
  const roster = repo.replyRoster(openingId, kind, roundId);
  if (!roster) return "Nobody is waiting on a reply for this job.";
  const { round } = roster;
  const { parseReply, extractReplyText, withUnpickedRejected } = await import("@/lib/reviewReply");
  const cleanBody = extractReplyText(body);
  const list = roster.applicationIds.map((applicationId) => {
    const app = repo.application(applicationId);
    const c = app ? repo.candidate(app.candidateId) : null;
    return { applicationId, name: c?.fullName ?? "Unknown" };
  });
  const parsed = await parseReply(cleanBody, list);
  const decided = parsed.decisions.filter((d) => d.outcome !== "hold");

  if (decided.length === 0) {
    return parsed.unmatched.length
      ? `Nobody has been moved — read this part yourself: ${parsed.unmatched.join(" · ")}`
      : "Nothing in that reply could be read as a decision. Nobody has been moved — say who is in, by name or by number.";
  }

  // Everyone in the email the reply did not pick is marked not selected, so
  // the set is closed (owner, 25 Sep). The store's write reaches the backend
  // itself; a second backend move here moved everyone twice (review of #56).
  const fullDecisions = withUnpickedRejected(parsed, round.applicationIds);
  const res = repo.applyReviewDecisions(round.id, fullDecisions.map((d) => ({ ...d, confirmed: false })), cleanBody);

  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath("/alerts");
  
  const shortlistedNames = fullDecisions
    .filter((d) => d.outcome === "shortlisted")
    .map((d) => {
      const app = repo.application(d.applicationId);
      return app ? repo.candidate(app.candidateId)?.fullName : null;
    })
    .filter(Boolean);

  const said =
    shortlistedNames.length > 0
      ? `Shortlisted: ${shortlistedNames.join(", ")}. ${res.rejected} not selected. Reply recorded.`
      : `Reply recorded for Set ${round.setNumber ?? 1}: ${res.rejected} not selected.`;
  return `${said}${res.stale ? ` ${res.stale} not moved because they have moved on since.` : ""}${
    parsed.unmatched.length ? ` Read yourself — nobody else was marked not selected: ${parsed.unmatched.join(" · ")}` : ""
  }`;
}

export async function readEodReply(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const kind = String(formData.get("kind") ?? "director") === "client" ? "client" : "director";
  const body = String(formData.get("reply") ?? "").trim();
  const go = (m: string) => redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(m)}`);
  if (!body) go("Paste the reply first.");
  go(await readReplyFor(openingId, kind, body));
}

/**
 * Check the recruiter's mailbox / shared shortlist inbox automatically via Microsoft Graph,
 * find replies matching this opening's open review rounds, and apply the decisions.
 */
export async function syncEodReplies(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { opening: "openingId" });
  const user = await getCurrentUser();
  const openingId = String(formData.get("openingId"));
  const kind = (String(formData.get("kind") ?? "director") === "client" ? "client" : "director") as "director" | "client";
  const go = (m: string) => redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(m)}`);

  const opening = repo.opening(openingId);
  if (!opening) go("Opening not found.");

  const waiting = repo.waitingOn(openingId, kind);
  if (waiting.length === 0) {
    go("Nobody is currently waiting on a review reply for this opening.");
  }

  const mailboxes = [user.email, repo.shortlistInbox(), process.env.MS_SENDER_EMAIL || "job@career141.com"].filter(Boolean);

  let messages: { id: string; from: string; subject: string; body: string; bodyPreview: string }[] = [];
  try {
    const { fetchMailboxMessages } = await import("@/lib/graphInbox");
    messages = await fetchMailboxMessages(mailboxes, 25);
  } catch (e) {
    go(safeErrorMessage(e, "Could not check the mailbox. Try again."));
  }

  if (!messages || messages.length === 0) {
    go("Checked mailbox — no recent messages found.");
  }

  const { matchReviewReply } = await import("@/lib/routing");
  let matchedMsg: (typeof messages)[0] | null = null;
  let targetRoundId: string | null = null;

  for (const msg of messages) {
    const target = matchReviewReply(
      { from: msg.from, subject: msg.subject, receivedAt: (msg as { receivedDateTime?: string }).receivedDateTime },
      {
        rounds: repo.reviewRounds().filter((r) => r.openingId === openingId && r.kind === kind && r.status !== "returned"),
        openings: repo.openings(),
        clients: repo.clients(),
        users: repo.users(),
      },
    );

    if (target.round && target.round.openingId === openingId) {
      matchedMsg = msg;
      targetRoundId = target.round.id;
      break;
    }
  }

  if (!matchedMsg || !targetRoundId) {
    go(`Checked ${messages.length} message(s) in mailbox — no new matching reply found for this opening yet.`);
  }

  const { extractReplyText } = await import("@/lib/reviewReply");
  const cleanBody = extractReplyText(matchedMsg!.body || matchedMsg!.bodyPreview || "");
  const outcome = await readReplyFor(openingId, kind, cleanBody, targetRoundId!);
  go(`Retrieved reply from ${matchedMsg!.from} ("${cleanBody.slice(0, 50)}"): ${outcome}`);
}

/** The one shortlist-replies box, changed by a director without a deploy. */
export async function setShortlistInbox(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const actor = await getCurrentUser();
  if (actor.role !== "admin" && actor.role !== "director") return;
  const v = String(formData.get("shortlistInbox") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)) {
    redirect("/people?msg=" + encodeURIComponent("That is not an email address."));
  }
  repo.setSetting("shortlistInbox", v);
  revalidatePath("/people");
  revalidatePath("/openings", "layout");
  redirect("/people?msg=" + encodeURIComponent(`Shortlist replies are now tracked at ${v}.`));
}

/**
 * A reply landed in the shared box and nobody knows which set it answers.
 *
 * This is what the shared shortlist inbox is FOR, and until now the matcher
 * that does it had no caller: the screen could only read a reply against the
 * round you happened to be looking at, which means you had to know the answer
 * before you could ask.
 *
 * Given the sender and the subject it finds the round itself — across every
 * opening, not just this one — and it is the exact call the inbound handler
 * will make when the mailbox is connected.
 */
export async function readInboundReply(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { opening: "openingId" });
  await getCurrentUser();
  const openingId = String(formData.get("openingId"));
  const kind = String(formData.get("kind") ?? "director");
  const from = String(formData.get("from") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("reply") ?? "").trim();
  const back = (m: string) =>
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(m)}`);

  if (!from || !body) fail("Needs at least who it came from and what they said.");

  const { classifyInbound, matchReviewReply } = await import("@/lib/routing");

  // Belt and braces: if it arrived at one of our addresses, it must be the
  // shortlist box. A CV that wandered in here is not a decision about anybody.
  const to = String(formData.get("to") ?? "").trim();
  if (to) {
    const kindOf = classifyInbound(to, repo.users(), repo.shortlistInbox());
    if (kindOf.kind === "application")
      fail("That came to an applications inbox, not the shortlist box — it is a CV, not a decision.");
    if (kindOf.kind === "not_ours") fail(`Nothing of ours receives at ${to}.`);
  }

  // The sender and subject say which job and whether it is the Director or
  // the client. Which email it answers does not matter — see readReplyFor.
  const target = matchReviewReply(
    { from, subject },
    {
      rounds: repo.reviewRounds(),
      openings: repo.openings(),
      clients: repo.clients(),
      users: repo.users(),
    },
  );
  if (!target.round) fail(`Could not place that reply. ${target.note}`);
  const round = target.round!;
  const o = repo.opening(round.openingId);
  back(`${o?.title ?? "That job"} (${round.kind}): ${await readReplyFor(round.openingId, round.kind, body, round.id)}`);
}

// ─── Convex bridge (proof of concept) ────────────────────────────────────────

/**
 * Read this deployment's live jobs as the signed-in TA.
 *
 * The first thing in this app to go through the Convex backend rather than the
 * JSON store, and deliberately the smallest one: it proves the whole chain
 * without changing a screen or writing anything.
 *
 *   signed cookie → TA user → Convex user (by email) → call with `actorId`
 *
 * Two calls go out, because they prove different halves and only one of them
 * is worth trusting on its own:
 *
 *   `jobs/jobs:getActiveJobsBasicInfo` has NO auth check — it is a plain query.
 *   A reply proves the transport, the admin key and the URL, and nothing at all
 *   about whether the actor was understood.
 *
 *   `ta/actor:whoami` goes through `requireUser`, which is the gate the other
 *   thirteen modules call. A reply naming the right person, with
 *   `source: "actor_id"`, is what proves the dual-mode adapter works for a
 *   cookie session with no Clerk identity anywhere.
 *
 * Returns a result rather than throwing: this is a probe, and a failure is
 * something to display, not a 500.
 */
export async function probeConvexAsCurrentUser(): Promise<
  | {
      ok: true;
      actor: { taUserId: string; email: string; convexUserId: string; role: string };
      whoami: { userId: string; email: string; fullName: string; role: string; source: string };
      jobs: { total: number; sample: { title: string; keyword: string; clientName: string }[] };
    }
  | { ok: false; reason: string }
> {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  // Reading is the least this can be. Anything that writes through this bridge
  // must ask `authorize` first, exactly as every other action here does.
  if (!can(user, "database.read").ok) return { ok: false, reason: "You cannot read the database." };

  const { convexActorForEmail, convexQuery, ConvexCallError } = await import("@/lib/convexServer");

  try {
    const actor = await convexActorForEmail(user.email);
    if (!actor) {
      return {
        ok: false,
        reason: `${user.email} has no account in the Convex backend, so there is nobody to act as. Create one there, or sign in as a TA who has one.`,
      };
    }
    if (!actor.isActive) return { ok: false, reason: `${actor.email} is deactivated in the backend.` };

    // The adapter's own test: no Clerk identity, an explicit actor.
    const whoami = await convexQuery<{
      userId: string;
      email: string;
      fullName: string;
      role: string;
      source: string;
    }>("ta/actor:whoami", { actorId: actor._id });

    const jobs = await convexQuery<
      { _id: string; title: string; keyword: string; clientName: string }[]
    >("jobs/jobs:getActiveJobsBasicInfo", {});

    return {
      ok: true,
      actor: { taUserId: user.id, email: user.email, convexUserId: actor._id, role: actor.role },
      whoami,
      jobs: {
        total: jobs.length,
        sample: jobs.slice(0, 5).map((j) => ({
          title: j.title,
          keyword: j.keyword,
          clientName: j.clientName,
        })),
      },
    };
  } catch (e) {
    if (e instanceof ConvexCallError) return { ok: false, reason: e.message };
    throw e;
  }
}

// ─── Development sign-in (lib/devSignin.ts) ──────────────────────────────────

/** Sign in as a desk account without Clerk. Refused unless dev sign-in is on and the build is not production. */
export async function devSignInAs(formData: FormData) {
  const { devSigninEnabled, devSessionValue, DEV_SESSION_COOKIE } = await import("@/lib/devSignin");
  if (!devSigninEnabled()) redirect("/signin");
  await primeStore();
  const id = String(formData.get("userId") ?? "");
  const user = repo.users().find((u) => u.id === id);
  if (!user || !user.isActive) redirect("/signin");
  const { cookies } = await import("next/headers");
  (await cookies()).set(DEV_SESSION_COOKIE, devSessionValue(user.id), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 12,
  });
  redirect("/");
}

export async function devSignOut() {
  const { DEV_SESSION_COOKIE } = await import("@/lib/devSignin");
  const { cookies } = await import("next/headers");
  const c = await cookies();
  c.delete(DEV_SESSION_COOKIE);
  c.delete("__session");
  c.delete("__client_uat");
  redirect("/signin");
}

// ─── Settings → Mailboxes ────────────────────────────────────────────────────

/** Read a shared mailbox into the TA System, or stop. Admins only. */
export async function setMailboxEnabled(formData: FormData) {
  await authorize(formData, "user.manage");
  const mailbox = String(formData.get("mailbox") ?? "");
  const enabled = formData.get("enabled") === "on";
  try {
    await backend.setMailboxEnabled(mailbox, enabled);
  } catch (e) {
    await fail(backendMessage(e, "The mailbox could not be changed."));
  }
  revalidatePath("/settings");
  await back(enabled ? `${mailbox} is being read. The first sync imports the last 30 days.` : `${mailbox} is no longer read.`);
}

/** Look at a mailbox now rather than at the next five-minute sync. */
export async function syncMailboxNow(formData: FormData) {
  await authorize(formData, "user.manage");
  const mailbox = String(formData.get("mailbox") ?? "");
  try {
    await backend.syncMailboxNow(mailbox);
  } catch (e) {
    await fail(backendMessage(e, "The sync could not be started."));
  }
  revalidatePath("/settings");
  await back(`Syncing ${mailbox}. New messages appear below within a minute; each waits 20 minutes before it is filed.`);
}


// ─── Answers beside the button ───────────────────────────────────────────────
//
// The same actions, for forms that show the outcome where it was asked for
// rather than at the top of the page (lib/inlineResult). `useActionState`
// hands the previous answer first; it is not needed.

export async function saveJobDetailsInline(_: ActionResult | null, formData: FormData) {
  return inline(() => saveJobDetails(formData));
}

export async function reextractJobDetailsInline(_: ActionResult | null, formData: FormData) {
  return inline(() => reextractJobDetails(formData));
}

export async function saveBriefNotesInline(_: ActionResult | null, formData: FormData) {
  return inline(() => saveBriefNotes(formData));
}

export async function updateCandidateContactInline(_: ActionResult | null, formData: FormData) {
  return inline(() => updateCandidateContact(formData));
}

export async function addToOpeningInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addToOpening(formData));
}

/** A successful save still navigates to the new opening; only a refusal answers here. */
export async function createOpeningStep1Inline(_: ActionResult | null, formData: FormData) {
  return inline(() => createOpeningStep1(formData));
}

export async function addLinkInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addLink(formData));
}

export async function addLinksBulkInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addLinksBulk(formData));
}

export async function generateJdInline(_: ActionResult | null, formData: FormData) {
  return inline(() => generateJdWithModel(formData));
}

export async function reviseJdInline(_: ActionResult | null, formData: FormData) {
  return inline(() => reviseJd(formData));
}

export async function restoreJdVersionInline(_: ActionResult | null, formData: FormData) {
  return inline(() => restoreJdVersion(formData));
}

export async function moveStageInline(_: ActionResult | null, formData: FormData) {
  return inline(() => moveStage(formData));
}

export async function runResearchInline(_: ActionResult | null, formData: FormData) {
  return inline(() => runResearch(formData));
}

export async function runBenchmarkInline(_: ActionResult | null, formData: FormData) {
  return inline(() => runBenchmark(formData));
}

export async function runSuggestionsInline(_: ActionResult | null, formData: FormData) {
  return inline(() => runSuggestions(formData));
}

export async function toggleLinkAddOnInline(_: ActionResult | null, formData: FormData) {
  return inline(() => toggleLinkAddOn(formData));
}

export async function toggleEyeMarkInline(_: ActionResult | null, formData: FormData) {
  return inline(() => toggleEyeMark(formData));
}

export async function decideCvMatchInline(_: ActionResult | null, formData: FormData) {
  return inline(() => decideCvMatch(formData));
}

export async function updateLinkInline(_: ActionResult | null, formData: FormData) {
  return inline(() => updateLink(formData));
}

export async function logOutreachInline(_: ActionResult | null, formData: FormData) {
  return inline(() => logOutreach(formData));
}

export async function addLeadNoteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addLeadNote(formData));
}

export async function addReviewNoteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addReviewNote(formData));
}

export async function removeReviewNoteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => removeReviewNote(formData));
}

export async function removeLeadNoteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => removeLeadNote(formData));
}

export async function addLinkTaNoteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addLinkTaNote(formData));
}

export async function removeLinkTaNoteInline(_: ActionResult | null, formData: FormData) {
  return inline(() => removeLinkTaNote(formData));
}

export async function addLinkToPipelineInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addLinkToPipeline(formData));
}

export async function moveBackToTablesInline(_: ActionResult | null, formData: FormData) {
  return inline(() => moveBackToTables(formData));
}

export async function deleteLinkInline(_: ActionResult | null, formData: FormData) {
  return inline(() => deleteLink(formData));
}

export async function toggleAddOnInline(_: ActionResult | null, formData: FormData) {
  return inline(() => toggleAddOn(formData));
}

export async function toggleBackupInline(_: ActionResult | null, formData: FormData) {
  return inline(() => toggleBackup(formData));
}

export async function scheduleInterviewInline(_: ActionResult | null, formData: FormData) {
  return inline(() => scheduleInterview(formData));
}

export async function saveReviewDetailsInline(_: ActionResult | null, formData: FormData) {
  return inline(() => saveReviewDetails(formData));
}

export async function sendFollowUpNowInline(_: ActionResult | null, formData: FormData) {
  return inline(() => sendFollowUpNow(formData));
}

export async function stopFollowUpNowInline(_: ActionResult | null, formData: FormData) {
  return inline(() => stopFollowUpNow(formData));
}

/**
 * A referee's current role, looked up on LinkedIn (plan 5.2, 21 Sep): the
 * designation on a CV is from when the CV was written, often years ago. One
 * web search for their LinkedIn profile; the title and company are read from
 * the result, never invented, and shown beside the CV's for the TA to judge.
 */
export async function verifyReferee(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  const refereeId = String(formData.get("refereeId") ?? "");
  const openingId = String(formData.get("openingId") ?? "");
  const result = await checkCandidateReferee(user, openingId, refereeId, null, {
    convexQuery,
    searchConfigured: serperConfigured,
    search: (query, limit) => import("@/lib/serper").then(({ search }) => search(query, limit)),
  });
  if (!result.ok) {
    if (result.notice) await note(result.message);
    await fail(result.message);
  }
  await done(result.message);
}

export async function verifyRefereeInline(_: ActionResult | null, formData: FormData) {
  return inline(() => verifyReferee(formData));
}

/** A saved report navigates to itself; a refusal answers beside Save. */
export async function saveReportInline(_: ActionResult | null, formData: FormData) {
  return inline(() => saveReport(formData));
}

/** The alert ids a form posted: every `alertId` field, as the bulk bar and a row's button send them. */
function postedAlertIds(formData: FormData): string[] {
  const alertIds = formData.getAll("alertId").map(String).filter(Boolean);
  if (alertIds.length === 0) {
    const single = String(formData.get("alertId") ?? "").trim();
    if (single) alertIds.push(single);
  }
  return alertIds;
}

/** The read-state service (src/lib/alerts/readState.ts), with this app's cache and backend. */
async function markAlertsFor(user: User, request: import("@/lib/alerts/readState").MarkAlertsRequest) {
  const { markAlerts } = await import("@/lib/alerts/readState");
  const outcome = await markAlerts(user, request, { revalidatePath, convexMutation });
  return outcome.ok ? done(outcome.message) : fail(outcome.message);
}

/**
 * Marks one, many, or all alerts as read for the current user. The rules live
 * in src/lib/alerts/readState.ts, shared with the mobile API.
 */
export async function markAlertsAsRead(formData: FormData) {
  await primeStore({ allApplications: true, followUps: true });
  const user = await getCurrentUser();
  if (!user) return fail("You must be signed in.");

  if (formData.get("all") === "true") {
    return markAlertsFor(user, { all: true, everyone: formData.get("isEveryone") === "true" });
  }
  return markAlertsFor(user, { read: true, ids: postedAlertIds(formData) });
}

export async function markAlertsAsReadInline(_: ActionResult | null, formData: FormData) {
  return inline(() => markAlertsAsRead(formData));
}

export async function markAlertsAsUnread(formData: FormData) {
  await primeStore({ allApplications: true, followUps: true });
  const user = await getCurrentUser();
  if (!user) return fail("You must be signed in.");
  return markAlertsFor(user, { read: false, ids: postedAlertIds(formData) });
}

export async function markAlertsAsUnreadInline(_: ActionResult | null, formData: FormData) {
  return inline(() => markAlertsAsUnread(formData));
}

export async function clearReadAlertsAction(formData: FormData) {
  await primeStore({});
  const user = await getCurrentUser();
  if (!user) return fail("You must be signed in.");
  repo.clearReadAlerts(user.id);
  revalidatePath("/alerts");
  return done("Read alert history cleared.");
}

// ─── Strategy Planner (8 Oct) ────────────────────────────────────────────────
//
// A TA Lead puts TAs on strategies in a job's table; each TA fills in their rows and submits.
// Every one of these resolves the opening from the record itself, never from
// the opening the browser sent alongside it.

/** authorize(), for an action whose record already says which opening it is on. */
async function authorizeOn(openingId: string, capability: Capability): Promise<User> {
  const user = await getCurrentUser();
  if (!openingId || !repo.opening(openingId)) await fail("That opening no longer exists.");
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((r) => r.doneBy.includes(user.id));
  const decision = can(user, capability, { openingId, assignment, ownerTaId: null, onStrategy });
  if (!decision.ok) await fail(decision.message);
  return user;
}

function revalidateStrategies(openingId?: string) {
  // The loaded tables are behind what was just written: the next load re-reads
  // them, so the person sees their own change and the other side sees it too.
  markTablesStale();
  revalidatePath("/strategy");
  revalidatePath("/strategy", "page");
  if (openingId) {
    revalidatePath(`/strategy/${openingId}`);
    revalidatePath(`/strategy/${openingId}`, "page");
    revalidatePath(`/openings/${openingId}/strategies`);
    revalidatePath(`/openings/${openingId}`);
  }
}

/** The row a form names, and the opening it is really on. */
function strategyRowOf(formData: FormData, field = "rowId") {
  const byId = String(formData.get(field) ?? "");
  const row = byId ? repo.strategyAssignment(byId) : null;
  if (row) return row;
  const openingId = String(formData.get("openingId") ?? "");
  const strategyId = String(formData.get("strategyId") ?? "");
  if (openingId && strategyId) {
    return repo.strategyAssignments(openingId).find((r) => r.strategyId === strategyId) ?? null;
  }
  return null;
}

/**
 * Debounces bells per key within 30 seconds. A lead clicking multiple strategies
 * rapidly generates one chime, while assignments made moments later are not silenced.
 */
/** Put a TA on a strategy for a job ("Done by"). The TA Lead's side of the table. */
export async function addStrategyDoneBy(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorizeOn(openingId, "strategy.assign");
  const strategyId = String(formData.get("strategyId") ?? "");
  const taId = String(formData.get("taId") ?? "");

  // The assignee must be an active account with access: the dropdown came from the browser.
  const opening = repo.opening(openingId)!;
  const ta = repo.user(taId);
  if (!ta || !ta.isActive || ta.role === "client") {
    await fail("That person does not have access.");
  }
  const s = repo.strategy(strategyId);
  if (!s) await fail("That strategy is no longer on the list.");

  const r = repo.addStrategyDoneBy({
    openingId,
    strategyId,
    taId,
    byUserId: user.id,
    byRole: user.role,
    today: colomboDayStart(Date.now()),
    now: Date.now(),
  });
  if (!r) await fail(`${s!.name} is retired. Bring it back on the Strategy list first.`);
  revalidateStrategies(openingId);
  if (!r!.added) await note(`${ta!.name} is already on ${s!.name}.`);

  // The bell says where, not which: the strategies are read on the job's page.
  if (isConvex() && taId !== user.id && bellDue(`${taId}:${openingId}`)) {
    await convexMutation("ta/notifications:create", {
      userId: taId,
      type: "strategy_assigned",
      title: "You were given strategies",
      body: `${user.name} put you on strategies for ${opening.title}.`,
      jobId: openingId,
    }).catch((e) => console.error("[notifications] strategy_assigned failed:", e));
    revalidatePath("/api/notifications");
  }
  await done(`Put ${ta!.name} on ${s!.name}.`);
}

/** Take a TA off a strategy. Whatever they already submitted stays on the row. */
export async function removeStrategyDoneBy(formData: FormData) {
  const openingIdParam = String(formData.get("openingId") ?? "");
  await primeStore(openingIdParam ? { openingId: openingIdParam } : undefined);
  const row = strategyRowOf(formData);
  if (!row) await fail("That strategy is no longer on this job's table.");
  await authorizeOn(row!.openingId, "strategy.assign");
  const taId = String(formData.get("taId") ?? "");
  if (!row!.doneBy.includes(taId)) await fail("They are not on that strategy.");
  repo.removeStrategyDoneBy(row!.id, taId);
  revalidateStrategies(row!.openingId);
  await done("Taken off.");
}

/** Accept every new strategy explicitly assigned to this TA on the job. */
export async function acceptStrategyAssignments(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const result = acceptStrategies(user, openingId, { convexMutation, markTablesStale, notify: revalidatePath });
  if (!result.ok) await fail(result.message);
  revalidateStrategies(openingId);
  if (result.ok && result.tone === "note") await note(result.message);
  await done(result.message);
}

/** The day the lead assigned a strategy; empty clears it. */
export async function setStrategyAssignedDate(formData: FormData) {
  await primeStore();
  const row = strategyRowOf(formData);
  if (!row) await fail("That strategy is no longer on this job's table.");
  await authorizeOn(row!.openingId, "strategy.assign");
  const typed = String(formData.get("date") ?? "").trim();
  const day = colomboDayFromValue(typed);
  if (typed && day === null) await fail("That is not a date.");
  repo.setStrategyAssignedDate(row!.id, day);
  revalidateStrategies(row!.openingId);
  await done(day === null ? "Date cleared." : "Date saved.");
}

/** Strike a strategy through for a job ("cannot be used here"), or bring it back. */
export async function setStrategyNotApplicable(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorizeOn(openingId, "strategy.assign");
  const strategyId = String(formData.get("strategyId") ?? "");
  const s = repo.strategy(strategyId) ?? repo.strategyRow(openingId, strategyId);
  if (!s) await fail("That strategy is no longer on the list.");
  const notApplicable = String(formData.get("na") ?? "") === "1";
  repo.setStrategyNotApplicable({ openingId, strategyId, notApplicable, byUserId: user.id, byRole: user.role });
  revalidateStrategies(openingId);
  const name = "name" in s! ? s!.name : s!.strategyName;
  await done(notApplicable ? `${name} is struck through for this job.` : `${name} can be used on this job again.`);
}

/**
 * A TA submits their rows on a job: whether and when they used each strategy,
 * and what they did and any improvement. Only rows ticked for the job (or that
 * they are on) and not struck through are taken; the rest of the form is
 * ignored, not trusted. A ticked row nobody put them on is taken only when they
 * filled it in, so it does not become theirs by being on the page (9 Oct).
 */
export async function submitStrategyUpdate(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const ids = formData.getAll("rowId").map(String).filter(Boolean);
  const result = await submitStrategies(user, openingId, ids.map((id) => ({
    rowId: id,
    used: formData.get(`used_${id}`) === "on",
    date: String(formData.get(`date_${id}`) ?? ""),
    note: String(formData.get(`note_${id}`) ?? ""),
  })), { convexMutation, markTablesStale, notify: revalidatePath });
  if (!result.ok) await fail(result.message);
  revalidateStrategies(openingId);
  await done(result.message);
}

/**
 * The lead's edits on a line of a job's strategy table (9 Oct), saved as each
 * one changes: `field` is "selected" (the tick), "assignedAt", "doneAt" (dates,
 * empty clears) or "note".
 */
export async function updateStrategyLine(formData: FormData) {
  const openingId = String(formData.get("openingId") ?? "");
  await primeStore({ openingId });
  const user = await authorizeOn(openingId, "strategy.assign");
  const strategyId = String(formData.get("strategyId") ?? "");
  const s = repo.strategy(strategyId) ?? repo.strategyRow(openingId, strategyId);
  if (!s) await fail("That strategy is no longer on the list.");
  const field = String(formData.get("field") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  const patch: { selected?: boolean; assignedAt?: number | null; doneAt?: number | null; note?: string | null } = {};
  if (field === "selected") {
    patch.selected = value === "1";
  } else if (field === "assignedAt" || field === "doneAt") {
    const day = colomboDayFromValue(value);
    if (value && day === null) await fail("That is not a date.");
    patch[field] = day;
  } else if (field === "note") {
    if (value.length > 500) await fail("Keep the note under 500 characters.");
    patch.note = value || null;
  } else {
    await fail("Nothing to save.");
  }
  if (!repo.updateStrategyLine({ openingId, strategyId, byUserId: user.id, byRole: user.role, ...patch })) {
    await fail("That strategy is retired. Bring it back on the Strategy list first.");
  }
  revalidateStrategies(openingId);
  const name = "name" in s! ? s!.name : s!.strategyName;
  await done(
    field === "selected"
      ? patch.selected ? `${name} is ticked: the TAs on this job can see it.` : `${name} is unticked: the TAs no longer see it.`
      : field === "note" ? "Note saved." : "Date saved.",
  );
}

/** A TA removes a proof image they attached. */
export async function removeStrategyProof(formData: FormData) {
  await primeStore();
  const row = strategyRowOf(formData);
  if (!row) await fail("That strategy is no longer on this job's table.");
  const user = await getCurrentUser();
  const proofId = String(formData.get("proofId") ?? "");
  const result = await removeStrategyPicture(user, row!.id, proofId, { convexMutation, markTablesStale, notify: revalidatePath });
  if (!result.ok) await fail(result.message);
  revalidateStrategies(row!.openingId);
  await done(result.message);
}

/** Add a strategy to the list, or change one. */
export async function saveStrategy(formData: FormData) {
  await primeStore();
  const user = await getCurrentUser();
  const decision = can(user, "strategy.manage");
  if (!decision.ok) await fail(decision.message);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) await fail("Give the strategy a name.");
  if (name.length > 120) await fail("Keep the name under 120 characters.");
  const description = String(formData.get("description") ?? "").trim().slice(0, 600) || null;
  const group = String(formData.get("group") ?? "").trim().slice(0, 60) || null;
  const id = String(formData.get("id") ?? "") || undefined;
  const saved = repo.saveStrategy({ id, name, description, group, byUserId: user.id });
  if (!saved) await fail("That name is already on the list, or the strategy no longer exists.");
  revalidateStrategies();
  await done(id ? "Strategy saved." : "Strategy added to the list.");
}

/** Retire a strategy from the list, or bring it back. Ones already given stay. */
export async function setStrategyActive(formData: FormData) {
  await primeStore();
  const user = await getCurrentUser();
  const decision = can(user, "strategy.manage");
  if (!decision.ok) await fail(decision.message);
  const s = repo.strategy(String(formData.get("id") ?? ""));
  if (!s) await fail("That strategy no longer exists.");
  const active = String(formData.get("active") ?? "") === "1";
  // Bringing one back must not duplicate a name that has been used again.
  if (active && repo.strategies().some((x) => x.id !== s!.id && x.name.trim().toLowerCase() === s!.name.trim().toLowerCase())) {
    await fail("A strategy with that name is already on the list.");
  }
  repo.setStrategyActive(s!.id, active);
  revalidateStrategies();
  await done(active ? "Strategy is back on the list." : "Strategy retired. Ones already given stay as they are.");
}

export async function addStrategyDoneByInline(_: ActionResult | null, formData: FormData) {
  return inline(() => addStrategyDoneBy(formData));
}

export async function removeStrategyDoneByInline(_: ActionResult | null, formData: FormData) {
  return inline(() => removeStrategyDoneBy(formData));
}

export async function setStrategyNotApplicableInline(_: ActionResult | null, formData: FormData) {
  return inline(() => setStrategyNotApplicable(formData));
}

export async function updateStrategyLineInline(_: ActionResult | null, formData: FormData) {
  return inline(() => updateStrategyLine(formData));
}

export async function submitStrategyUpdateInline(_: ActionResult | null, formData: FormData) {
  return inline(() => submitStrategyUpdate(formData));
}

export async function acceptStrategyAssignmentsInline(_: ActionResult | null, formData: FormData) {
  return inline(() => acceptStrategyAssignments(formData));
}

export async function removeStrategyProofInline(_: ActionResult | null, formData: FormData) {
  return inline(() => removeStrategyProof(formData));
}

export type CompanyReferenceColleague = {
  id: string;
  fullName: string;
  currentTitle: string;
  currentEmployer: string;
  phone: string | null;
  email: string | null;
  kind?: "candidate" | "referee";
  latestApp?: { id: string; openingId: string; stage: string } | null;
};

/**
 * Look up people in our database who work at the same company (Company Reference).
 * Used in Candidate Profile and Excel Tables to find backchannel contacts and phone numbers.
 * Prioritizes colleagues and referees with direct phone numbers first.
 */
export async function getCompanyReferences(input: {
  company: string;
  excludeCandidateId?: string | null;
  openingId?: string;
}): Promise<{ ok: true; company: string; colleagues: CompanyReferenceColleague[] } | { ok: false; message: string }> {
  const company = (input.company || "").trim();
  if (!company) return { ok: true, company: "", colleagues: [] };

  // Names, phones and emails across the whole database: always on a job the
  // person may source for. Without an opening the check was skipped and any
  // signed-in account, a client's too, could list a company's people (review, 8 Oct).
  if (!input.openingId) return { ok: false, message: "Open this from a job." };
  await primeStore({ openingId: input.openingId });
  const user = await getCurrentUser();
  const assignment = repo.assignmentFor(input.openingId, user.id) ?? null;
  const allowed = can(user, "opening.sourcing", { openingId: input.openingId, assignment });
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const colleagues: CompanyReferenceColleague[] = [];
  const existingIds = new Set<string>();

  const excludeId = input.excludeCandidateId || undefined;

  // 1. From local memory store (candidates)
  const storeCandidates = repo.peopleAtCompany(company, excludeId);
  for (const c of storeCandidates) {
    if (existingIds.has(c.id)) continue;
    const apps = repo.applicationsForCandidate(c.id);
    const latestApp = apps[0] ? { id: apps[0].id, openingId: apps[0].openingId, stage: apps[0].stage } : null;
    colleagues.push({
      id: c.id,
      fullName: c.fullName,
      currentTitle: c.currentTitle ?? "",
      currentEmployer: c.currentEmployer ?? company,
      phone: c.phone ?? null,
      email: c.email ?? null,
      kind: "candidate",
      latestApp,
    });
    existingIds.add(c.id);
  }

  // 2. From Convex if enabled (fetches both candidates and CV referees)
  if (isConvex()) {
    try {
      const backendResults = await convexQuery<{
        candidates: { id: string; fullName: string; currentTitle: string; currentEmployer: string; phone: string | null; email: string | null }[];
        referees: { id: string; name: string; title: string | null; company: string | null; phone: string | null; email: string | null; relationship: string | null }[];
      }>("ta/candidates:peopleAtCompany", {
        company,
        excludeCandidateId: excludeId,
        limit: 400,
      }).catch(() => null);

      // Referees from CVs who work at this company (managers, HR, etc.)
      if (backendResults?.referees) {
        for (const ref of backendResults.referees) {
          if (!existingIds.has(ref.id)) {
            colleagues.push({
              id: ref.id,
              fullName: ref.name,
              currentTitle: ref.title || "CV Referee",
              currentEmployer: ref.company || company,
              phone: ref.phone,
              email: ref.email,
              kind: "referee",
            });
            existingIds.add(ref.id);
          }
        }
      }

      // Query dedicated referee search for company and base company name variants
      const baseCompany = company.replace(/\b(plc|ltd|limited|pvt|private|inc|corp|corporation|group)\b/gi, "").replace(/\s+/g, " ").trim();
      const companyVariants = [company];
      if (baseCompany && baseCompany.toLowerCase() !== company.toLowerCase() && baseCompany.length >= 3) {
        companyVariants.push(baseCompany);
      }

      const refSearchRes = await convexQuery<{
        people: {
          id: string;
          name: string;
          designation: string | null;
          company: string | null;
          phone: string | null;
          email: string | null;
        }[];
      }>("ta/referenceSearch:search", {
        criteria: {
          designations: [],
          companies: companyVariants,
          name: null,
          loose: null,
          needsContact: false,
          industry: null,
          summary: company,
        },
      }).catch(() => null);

      if (refSearchRes?.people) {
        for (const ref of refSearchRes.people) {
          if (!existingIds.has(ref.id)) {
            colleagues.push({
              id: ref.id,
              fullName: ref.name,
              currentTitle: ref.designation || "CV Referee",
              currentEmployer: ref.company || company,
              phone: ref.phone,
              email: ref.email,
              kind: "referee",
            });
            existingIds.add(ref.id);
          }
        }
      }

      // Candidates who work at this company
      if (backendResults?.candidates) {
        for (const cand of backendResults.candidates) {
          if (!existingIds.has(cand.id)) {
            const apps = repo.applicationsForCandidate(cand.id);
            const latestApp = apps[0] ? { id: apps[0].id, openingId: apps[0].openingId, stage: apps[0].stage } : null;
            colleagues.push({
              id: cand.id,
              fullName: cand.fullName,
              currentTitle: cand.currentTitle,
              currentEmployer: cand.currentEmployer || company,
              phone: cand.phone,
              email: cand.email,
              kind: "candidate",
              latestApp,
            });
            existingIds.add(cand.id);
          }
        }
      }
    } catch (err) {
      console.warn("[getCompanyReferences] Convex lookup failed:", err);
    }
  }

  // 3. Sort contacts: verified phone numbers at the very top!
  colleagues.sort((a, b) => {
    const aPhone = Boolean(a.phone && a.phone.trim());
    const bPhone = Boolean(b.phone && b.phone.trim());
    if (aPhone && !bPhone) return -1;
    if (!aPhone && bPhone) return 1;

    // Referees/managers with phone numbers first
    if (aPhone && bPhone) {
      if (a.kind === "referee" && b.kind !== "referee") return -1;
      if (a.kind !== "referee" && b.kind === "referee") return 1;
    }

    const aEmail = Boolean(a.email && a.email.trim());
    const bEmail = Boolean(b.email && b.email.trim());
    if (aEmail && !bEmail) return -1;
    if (!aEmail && bEmail) return 1;

    return a.fullName.localeCompare(b.fullName);
  });

  return { ok: true, company, colleagues };
}

/**
 * Upload a screenshot to Convex file storage.
 * Limits file size to 3 MB and requires image MIME type.
 */
export async function uploadFeedbackScreenshotAction(
  formData: FormData
): Promise<{ ok: true; storageId: string } | { ok: false; message: string }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, message: "You must be logged in to upload screenshots." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "No image file provided." };
  }

  const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
  if (file.size > MAX_BYTES) {
    return { ok: false, message: "Screenshot file size must be under 3 MB." };
  }

  if (file.type && !file.type.startsWith("image/")) {
    return { ok: false, message: "Only image files (PNG, JPG, WebP, GIF) are allowed." };
  }

  if (!isConvex()) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const base64 = `data:${file.type || "image/png"};base64,${bytes.toString("base64")}`;
    return { ok: true, storageId: base64 };
  }

  try {
    const uploadUrl = await convexMutation<string>("ta/storage:recordingUploadUrl", {});
    const put = await fetch(internalUploadUrl(uploadUrl), {
      method: "POST",
      headers: { "content-type": file.type || "image/png" },
      body: Buffer.from(await file.arrayBuffer()),
    });
    if (!put.ok) {
      return { ok: false, message: `Failed to upload image to storage (${put.status}).` };
    }
    const { storageId } = (await put.json()) as { storageId: string };
    return { ok: true, storageId };
  } catch (err) {
    console.warn("[uploadFeedbackScreenshotAction] Upload failed:", err);
    return { ok: false, message: "Failed to upload screenshot to file storage." };
  }
}

/**
 * Submit feedback or bug report from any TA.
 * Initial status is always "pending_lead".
 */
export async function submitFeedbackAction(input: {
  category?: FeedbackCategory;
  priority?: FeedbackPriority;
  title?: string;
  description: string;
  pageUrl?: string;
  openingId?: string;
  screenshot?: string;
}): Promise<{ ok: true; id: string; status: FeedbackStatus } | { ok: false; message: string }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, message: "You must be logged in to submit feedback." };
  }

  const description = (input.description || "").trim();
  if (!description) {
    return { ok: false, message: "Please provide a description of the feedback or issue." };
  }

  const firstLine = description.split("\n")[0].trim();
  const derivedTitle = firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
  const title = (input.title || "").trim() || derivedTitle || "Feedback submission";
  const category: FeedbackCategory = input.category || "other";
  const priority: FeedbackPriority = input.priority || "medium";

  const pageUrl = input.pageUrl === "/feedback" ? "" : (input.pageUrl || "");

  const isLeadOrAdmin = user.role === "ta_lead" || user.role === "director" || user.role === "admin";
  const now = Date.now();
  const status: FeedbackStatus = isLeadOrAdmin ? "approved_for_admin" : "pending_lead";
  const roleTitle = user.role === "admin" ? "Admin" : user.role === "director" ? "Director" : "TA Lead";

  const id = repo.addFeedback({
    submittedBy: user.id,
    submittedByName: user.name || "Anonymous",
    submittedByRole: user.role,
    category,
    priority,
    title,
    description,
    pageUrl,
    openingId: input.openingId,
    screenshot: input.screenshot,
    status,
    ...(isLeadOrAdmin
      ? {
          leadReviewedBy: user.id,
          leadReviewedByName: user.name || roleTitle,
          leadReviewedAt: now,
          leadNotes: `Submitted directly by ${roleTitle}`,
        }
      : {}),
  });

  revalidatePath("/feedback");
  return { ok: true, id, status };
}

/**
 * TA Lead reviews feedback:
 * - "approved_for_admin": Escalates to Admin review queue
 * - "resolved_by_lead": Resolved directly by Lead
 * - "declined_by_lead": Declined by Lead
 */
export async function leadReviewFeedbackAction(input: {
  feedbackId: string;
  decision: "approved_for_admin" | "resolved_by_lead" | "declined_by_lead";
  leadNotes?: string;
}): Promise<{ ok: true; status: FeedbackStatus } | { ok: false; message: string }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, message: "Authentication required." };
  }

  if (user.role !== "ta_lead" && user.role !== "director") {
    return { ok: false, message: "Only TA Leads or Directors can review feedback submissions." };
  }

  const existing = repo.feedback(input.feedbackId);
  if (!existing) {
    return { ok: false, message: "Feedback item not found." };
  }

  const now = Date.now();
  const patch: Partial<FeedbackItem> = {
    status: input.decision,
    leadReviewedBy: user.id,
    leadReviewedByName: user.name || "TA Lead",
    leadReviewedAt: now,
    leadNotes: input.leadNotes?.trim() || undefined,
    resolvedAt: input.decision === "resolved_by_lead" ? now : undefined,
  };

  repo.updateFeedback(input.feedbackId, patch);
  revalidatePath("/feedback");
  return { ok: true, status: input.decision };
}

/**
 * Admin action on feedback that was approved and escalated by TA Lead:
 * - "in_progress" | "resolved" | "declined_by_admin"
 */
export async function adminUpdateFeedbackAction(input: {
  feedbackId: string;
  status: "in_progress" | "resolved" | "declined_by_admin";
  adminResolution?: string;
}): Promise<{ ok: true; status: FeedbackStatus } | { ok: false; message: string }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, message: "Authentication required." };
  }

  if (user.role !== "admin" && user.role !== "director") {
    return { ok: false, message: "Only Admins or Directors can update the Admin feedback queue." };
  }

  const existing = repo.feedback(input.feedbackId);
  if (!existing) {
    return { ok: false, message: "Feedback item not found." };
  }

  const now = Date.now();
  const patch: Partial<FeedbackItem> = {
    status: input.status,
    adminReviewedBy: user.id,
    adminReviewedByName: user.name || "Admin",
    adminReviewedAt: now,
    adminResolution: input.adminResolution?.trim() || undefined,
    resolvedAt: input.status === "resolved" ? now : undefined,
  };

  repo.updateFeedback(input.feedbackId, patch);
  revalidatePath("/feedback");
  return { ok: true, status: input.status };
}

/**
 * Fetch feedbacks according to caller's role.
 */
export async function getFeedbacksAction(): Promise<{
  ok: true;
  feedbacks: FeedbackItem[];
  currentUser: User;
} | { ok: false; message: string }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, message: "Authentication required." };
  }
  const feedbacks = repo.feedbacks(user);
  return { ok: true, feedbacks, currentUser: user };
}

/**
 * Mark all visible feedback items as seen for current user so the alert badge clears.
 */
export async function markFeedbackSeenAction(): Promise<{ ok: boolean }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) return { ok: false };
  repo.markAllFeedbackSeen(user.id, user);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Mark specific feedback items as read for current user.
 */
export async function markFeedbacksReadAction(feedbackIds: string[]): Promise<{ ok: boolean }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) return { ok: false };
  repo.markFeedbacksRead(user.id, feedbackIds);
  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Delete feedback items.
 */
export async function deleteFeedbacksAction(feedbackIds: string[]): Promise<{ ok: boolean; message?: string }> {
  await primeStore();
  const user = await getCurrentUser();
  if (!user) return { ok: false, message: "Authentication required." };
  if (user.role !== "ta_lead" && user.role !== "admin" && user.role !== "director") {
    return { ok: false, message: "Only TA Leads, Admins, or Directors can delete feedback." };
  }
  if (
    !Array.isArray(feedbackIds) ||
    feedbackIds.length === 0 ||
    feedbackIds.length > 100 ||
    feedbackIds.some((id) => typeof id !== "string")
  ) {
    return { ok: false, message: "Select up to 100 feedback items to delete." };
  }
  const visibleIds = new Set(repo.feedbacks(user).map((feedback) => feedback.id));
  if (feedbackIds.some((id) => !visibleIds.has(id))) {
    return { ok: false, message: "One or more feedback items are unavailable." };
  }
  for (const id of feedbackIds) {
    repo.deleteFeedback(id);
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
