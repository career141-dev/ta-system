"use server";

import { revalidatePath } from "next/cache";
import { repo } from "@/data/store";
import { getCurrentUser, SESSION_COOKIE, sessionValue } from "@/lib/session";
import { can, isDeskWide, type Capability } from "@/lib/auth";
import { headers } from "next/headers";
import type { FollowUpCallOutcome, User } from "@/data/types";
import type { CallKind, CallOutcome, ExtractedBrief, PriorityTier, Stage } from "@/data/types";
import { buildJd, extractFromText, EMPTY_EXTRACT } from "@/lib/intake";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  generateJdText,
  generateResearch,
  parseResearch,
  toCitations,
  type OpeningContext,
} from "@/lib/headhunt";
import { aiStatus, gemini } from "@/lib/ai";
import { MAX_ROUNDS, benchmarkViaSearch, runSourcing } from "@/lib/sourcing";
import { canonicalProfile } from "@/lib/serper";
import { draftsFor } from "@/lib/followup";
import { colomboLocalToInstant } from "@/lib/calendar";
import { dateAt } from "@/lib/format";
import { findDatabaseMatches } from "@/lib/dbMatch";
import { primeStore } from "@/data/prime";

// ─── Authorization ───────────────────────────────────────────────────────────

/**
 * Go back to the page the form was on, carrying a message.
 *
 * A refused write that redirects to a fixed page, or to one that ignores the
 * message, looks like a dead button. Returning to the referring page keeps the
 * person where they were and tells them why.
 */
async function back(message: string): Promise<never> {
  const ref = (await headers()).get("referer");
  let to = "/";
  if (ref) {
    try {
      const u = new URL(ref);
      u.searchParams.set("msg", message);
      to = u.pathname + u.search;
    } catch {
      /* an unreadable referer falls back to the dashboard */
    }
  } else {
    to = `/?msg=${encodeURIComponent(message)}`;
  }
  redirect(to);
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
    if (!id) await back("Something on this form was missing. Reload the page and try again.");
    const hit = repo.openingOf(kind, id);
    if (!hit.found) await back("That record no longer exists — it may have been removed.");
    if (sentOpening && hit.openingId && hit.openingId !== sentOpening) {
      await back("That record belongs to a different opening.");
    }
    openingId = hit.openingId ?? openingId;
    ownerTaId = hit.ownerTaId ?? ownerTaId;
  }

  if (ref.candidate) {
    // Editing a person through an opening needs them to be on it — otherwise
    // any opening you can reach becomes a way to edit anybody in the database.
    const candidateId = String(formData.get(ref.candidate) ?? "");
    const onIt = !!openingId && repo.applications(openingId).some((a) => a.candidateId === candidateId);
    if (!onIt) await back("That candidate is not on this opening.");
  }

  if (openingId && !repo.opening(openingId)) await back("That opening no longer exists.");

  const assignment = openingId ? repo.assignmentFor(openingId, user.id) ?? null : null;
  const decision = can(user, capability, { openingId, assignment, ownerTaId });
  if (!decision.ok) await back(decision.message);
  return user;
}

export async function moveStage(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const stage = String(formData.get("stage")) as Stage;
  const openingId = String(formData.get("openingId"));
  const picked = String(formData.get("reason") ?? "");
  const other = String(formData.get("reasonOther") ?? "").trim();
  const reason = picked === "Other" ? other || "Other" : other ? `${picked} — ${other}` : picked;

  // The collision lock is checked in `authorize`, alongside everything else.

  // Director and client shortlists say somebody approved this person. Moving
  // there by hand needs that authority — otherwise the reviewer's reply is the
  // route, recorded on the end-of-day page (audit finding 12).
  const decides =
    stage === "director_shortlist" ? "decide.director" : stage === "client_shortlist" ? "decide.client" : null;
  if (decides) {
    const verdict = can(user, decides, {
      openingId,
      assignment: repo.assignmentFor(openingId, user.id) ?? null,
    });
    if (!verdict.ok) await back(verdict.message);
  }

  // A rejection without a reason is a row nobody can learn from. The dedicated
  // Reject form asked for one; the generic menu let you skip it.
  if ((stage === "rejected" || stage === "dropped_out") && !reason.trim()) {
    await back(stage === "rejected" ? "Say why they were rejected." : "Say why they dropped out.");
  }

  const res = repo.moveStage(appId, stage, user.id, reason || undefined);
  if (!res.ok) await back(res.message);
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function claimCandidate(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  repo.shortlist(appId, user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
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
  if (ids.length === 0) await back("Tick at least one candidate.");
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  let done = 0;
  let skipped = 0;
  for (const id of ids) {
    const app = repo.application(id);
    if (!app || app.openingId !== openingId) { skipped++; continue; }
    if (!can(user, "opening.act", { openingId, assignment, ownerTaId: app.ownerTaId }).ok) { skipped++; continue; }
    const r = repo.shortlist(id, user.id);
    if (r.ok) done++; else skipped++;
  }
  revalidatePath(`/openings/${openingId}`, "layout");
  await back(
    `${done} shortlisted and sent to Follow-up.${skipped ? ` ${skipped} skipped — already taken by someone else.` : ""}`,
  );
}

export async function logCall(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  repo.recordCall({
    applicationId: appId,
    kind: String(formData.get("kind")) as CallKind,
    outcome: String(formData.get("outcome")) as CallOutcome,
    body: String(formData.get("body") ?? ""),
    structured: null,
    source: "manual",
    recordedBy: user.id,
  });
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function addLink(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const url = String(formData.get("url") ?? "").trim();
  if (url) repo.addLink(openingId, url, user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function toggleEyeMark(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  repo.toggleEyeMark(String(formData.get("entryId")));
  revalidatePath(`/openings/${openingId}`, "layout");
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
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.create");
  const next = String(formData.get("next") ?? "save");
  const clientId = String(formData.get("clientId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const notes = String(formData.get("notes") ?? "");
  const recordingKey = String(formData.get("recordingKey") ?? "") || null;
  const consentText = String(formData.get("consentText") ?? "") || null;
  const durationMs = Number(formData.get("durationMs") ?? 0) || null;

  // Where the job is, whose passport the client wants, and — only where they
  // said so — which gender. These three decide where sourcing looks, so they are
  // asked at intake rather than inferred from the address later (§8A.2).
  const country = String(formData.get("country") ?? "").trim();
  const hiringFor = String(formData.get("hiringFor") ?? "local");
  const gender = String(formData.get("targetGender") ?? "").trim() || null;

  const isLead = user.role === "ta_lead" || user.role === "admin";
  const assigned = isLead
    ? formData.getAll("assignedTaIds").map(String).filter(Boolean)
    : [user.id];

  if (!clientId || !title || assigned.length === 0) return;

  const extracted = notes.trim()
    ? { ...extractFromText(notes), title }
    : { ...EMPTY_EXTRACT, title };

  const briefId = repo.createBrief({
    clientId,
    openingId: null,
    kind: isLead ? "management_to_lead" : "lead_to_ta",
    capturedBy: user.id,
    capturedAt: Date.now(),
    method: recordingKey ? (notes.trim() ? "both" : "recording") : "notes",
    notesMarkdown: notes,
    transcriptStatus: recordingKey ? "unavailable" : "none",
    transcript: null,
    recordingKey,
    recordingDurationMs: durationMs,
    consentAcknowledgedBy: consentText ? user.id : null,
    consentAcknowledgedAt: consentText ? Date.now() : null,
    consentText,
    extracted,
  });

  // The JD stays empty here. It is written on screen two, by the TA.
  const openingId = repo.createOpeningFromBrief(briefId, {
    clientId,
    country,
    hiringFor,
    targetGender: gender,
    jdMarkdown: "",
    taLeadId: isLead ? user.id : (repo.users().find((u) => u.role === "ta_lead")?.id ?? user.id),
    assignedTaIds: assigned,
    directorId: repo.users().find((u) => u.role === "director")?.id ?? null,
  });

  revalidatePath("/openings", "layout");

  // The groundwork starts the moment the job exists, not when somebody finds
  // the button (13 September): the JD draft for the TA to approve, the market
  // research, and the first sourcing round, so there are people waiting when
  // the team opens it. It runs after the response is sent, so creating the
  // opening is not held up by three model calls.
  // Research no longer runs by itself, and sourcing waits for the approved JD
  // (13 September): a round run on an unapproved draft searched with the wrong
  // words, and then ran again on approval whenever it had found nobody.
  after(async () => {
    try {
      await draftJd(openingId);
    } catch (err) {
      console.error(`[prepare ${openingId}]`, err);
    }
    revalidatePath(`/openings/${openingId}`, "layout");
  });

  if (next === "jd") redirect(`/openings/${openingId}/jd`);
  if (next === "again") redirect(`/openings/new?created=${openingId}`);
  redirect(`/openings/${openingId}`);
}

/** Screen two — the TA saves their notes before generating from them. */
export async function saveBriefNotes(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const notes = String(formData.get("notes") ?? "");
  const opening = repo.opening(openingId);
  if (!opening?.briefId) return;
  repo.updateBrief(opening.briefId, {
    notesMarkdown: notes,
    extracted: notes.trim()
      ? { ...extractFromText(notes), title: opening.title }
      : { ...EMPTY_EXTRACT, title: opening.title },
  });
  revalidatePath(`/openings/${openingId}`, "layout");
}

/**
 * The TA generates the JD from the brief. Everything the brief yielded comes
 * through automatically; the TA corrects it here rather than anyone typing it
 * in twice.
 */
/** Spec §5.2 — the TA reads the JD and approves it; only then is it live. */
export async function approveJd(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const jd = String(formData.get("jdMarkdown") ?? "");
  if (jd.trim()) repo.updateJd(openingId, jd);
  repo.approveJd(openingId, user.id);

  // Spec §8A.2 — the first sourcing round starts here, without being asked. The
  // JD is the search vocabulary, so this is the first moment a good search is
  // possible, and a TA should find a list waiting rather than a button.
  // The database is searched for people we already hold who fit the JD
  // that was just agreed.
  after(async () => {
    await findDatabaseMatches(openingId, "jd_approved").catch(() => undefined);
    revalidatePath(`/openings/${openingId}`, "layout");
  });

  if (repo.suggestions(openingId).length === 0) {
    // The auto-run belongs to the TA the opening is on, not to whoever
    // approved the JD — a lead approving it must not end up owning the list.
    const owner = repo.opening(openingId)?.assignedTaIds[0];
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
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const o = repo.opening(openingId);
  if (!o) return;
  if (!o.assignedTaIds.includes(user.id) && user.role === "ta") return;
  const jd = String(formData.get("jdMarkdown") ?? "");
  if (jd.trim()) repo.updateJd(openingId, jd);
  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(`/openings/${openingId}/jd`);
}

export async function addJobPost(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const where = String(formData.get("channel") ?? "linkedin");
  const channel = (["linkedin", "facebook", "email_campaign"] as const).find((c) => c === where) ?? "linkedin";
  const r = repo.addJobPost(openingId, title, user.id, String(formData.get("liveOnLinkedIn")) === "1", channel);
  if (!r.ok) await back(r.message);
  revalidatePath(`/openings/${openingId}`, "layout");
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
  repo.updatePost(postId, { aliasKeywords: aliases, country, assignedTaId });
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function setPostStatus(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { post: "postId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const postId = String(formData.get("postId"));
  const status = String(formData.get("status")) as "draft" | "live" | "paused" | "closed";
  repo.updatePost(postId, { status, postedAt: status === "live" ? Date.now() : undefined });
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

export async function toggleAddOn(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const appId = String(formData.get("appId"));
  const openingId = String(formData.get("openingId"));
  const on = String(formData.get("on")) === "1";
  repo.setAddOn(appId, on);
  revalidatePath(`/openings/${openingId}`, "layout");
}

// ─── Link vault (spec §4.5) ──────────────────────────────────────────────────

export async function updateLink(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const entryId = String(formData.get("entryId"));
  const outcome = String(formData.get("outcome") ?? "") as import("@/data/types").LinkOutcome;
  const phoneNumber = String(formData.get("phoneNumber") ?? "").trim() || null;
  const phoneSource = (String(formData.get("phoneSource") ?? "") || null) as
    | import("@/data/types").LinkVaultEntry["phoneSource"];
  const name = String(formData.get("name") ?? "").trim() || null;
  const company = String(formData.get("company") ?? "").trim() || null;
  repo.updateLink(entryId, { outcome, phoneNumber, phoneSource, name, company });
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function logOutreach(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const entryId = String(formData.get("entryId"));
  const note = String(formData.get("note") ?? "").trim();
  const channel = String(formData.get("channel") ?? "linkedin");
  if (note) repo.logOutreach(entryId, user.id, channel, note);
  revalidatePath(`/openings/${openingId}`, "layout");
}


// ─── Opening admin (spec §4.2) ───────────────────────────────────────────────

export async function setOpeningStatus(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const status = String(formData.get("status")) as "open" | "on_hold" | "closed" | "filled";
  repo.setOpeningStatus(openingId, status);
  revalidatePath("/openings", "layout");
  revalidatePath(`/openings/${openingId}`, "layout");
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

  const rows = ids
    .map((userId, i) => ({
      userId,
      role: roles[i] as import("@/data/types").AssignmentRole,
    }))
    .filter((r) => r.userId && r.role);

  // One person, one seat: the last row wins if somebody is listed twice.
  const unique = [...new Map(rows.map((r) => [r.userId, r])).values()];
  const recruiters = unique.filter(
    (r) => r.role === "primary_recruiter" || r.role === "supporting_recruiter",
  );
  if (recruiters.length === 0) {
    redirect(
      `/openings/${openingId}?msg=${encodeURIComponent(
        "A team needs at least one recruiter on it. Nothing was changed.",
      )}`,
    );
  }

  repo.setAssignments(openingId, unique, user.id);
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function addClient(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const name = String(formData.get("name") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim() || "—";
  if (!name) return;

  // The form has always asked for the main contact. Until the 12 Sep sweep it
  // was read off the request and thrown away.
  const contactName = String(formData.get("contactName") ?? "").trim();
  const contacts = contactName
    ? [
        {
          name: contactName,
          title: String(formData.get("contactTitle") ?? "").trim(),
          email: String(formData.get("contactEmail") ?? "").trim(),
          isPrimary: true,
        },
      ]
    : [];

  let newId: string;
  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    newId = (await convexMutation<string>("ta/clients:add", {
      actorId: actor?._id,
      name,
      industry,
      contacts,
    })) ?? "";
  } else {
    newId = repo.addClient({ name, industry, contacts });
  }

  const intent = String(formData.get("action") ?? "save");

  revalidatePath("/clients");
  revalidatePath("/openings/new");

  if (intent === "create_job") {
    redirect(`/openings/new?client=${encodeURIComponent(newId)}`);
  }
}

export async function updateClient(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const clientId = String(formData.get("clientId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const esa = String(formData.get("esaSignedAt") ?? "").trim();
  const industry = String(formData.get("industry") ?? "").trim() || "—";
  const status = String(formData.get("status") ?? "active") as "active" | "dormant" | "archived";
  const esaSignedAt = esa ? new Date(esa).getTime() : null;

  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    await convexMutation("ta/clients:update", {
      actorId: actor?._id,
      clientId,
      name,
      industry,
      status,
      esaSignedAt,
    });
  } else {
    repo.updateClient(clientId, {
      name,
      industry,
      status,
      esaSignedAt,
    });
  }
  revalidatePath("/clients");
  revalidatePath("/openings/new");
}

export async function deleteClient(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "client.manage");
  const clientId = String(formData.get("clientId"));

  const { isConvex } = await import("@/data/mode");
  let res: { ok: boolean; openings?: number } = { ok: true };
  if (isConvex()) {
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    res = await convexMutation<{ ok: boolean; openings?: number }>("ta/clients:remove", {
      actorId: actor?._id,
      clientId,
    });
  } else {
    res = repo.deleteClient(clientId);
  }
  revalidatePath("/clients");
  revalidatePath("/openings/new");
  // Refused because work is filed under it — the page says so rather than
  // pretending the press did nothing.
  if (!res.ok) redirect(`/clients?held=${res.openings}`);
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
    await convexMutation("ta/clients:saveContacts", {
      actorId: actor?._id,
      clientId,
      contacts,
    });
  } else {
    repo.setContacts(clientId, contacts);
  }
  revalidatePath("/clients");
}

// ─── Deletes and edits (12 Sep sweep) ────────────────────────────────────────

export async function deleteOpening(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.manage", { opening: "openingId" });
  // Deleting a whole role and everything under it is a desk decision, not one
  // recruiter's.
  if (!isDeskWide(user)) await back("Only a lead, director or admin can delete an opening. Close it instead.");
  const openingId = String(formData.get("openingId"));
  const r = repo.deleteOpening(openingId);
  if (!r.ok) await back(r.message);
  revalidatePath("/openings", "layout");
  revalidatePath("/clients");
  redirect("/openings");
}

/**
 * Everything the intake screen sets, changeable afterwards. A client who moves
 * the band or adds a second location is the normal case, not the exception.
 */
export async function updateOpening(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const list = (v: FormDataEntryValue | null) =>
    String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  // Commas and currency go; a minus sign does not. Stripping it turned "-5000"
  // into 5000 (audit finding 40). A negative or zero amount is no amount.
  const num = (v: FormDataEntryValue | null) => {
    const n = Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const title = String(formData.get("title") ?? "").trim();
  if (!title) await back("An opening needs a title.");
  const salaryMin = num(formData.get("salaryMin"));
  const salaryMax = num(formData.get("salaryMax"));
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
    await back("The salary 'from' is higher than the 'to'.");
  }
  const tier = String(formData.get("priorityTier") ?? "P3");
  if (!["P1", "P2", "P3", "P4", "P5"].includes(tier)) await back("Pick a priority from the list.");
  const currency = String(formData.get("salaryCurrency") ?? "LKR");
  if (!/^[A-Z]{3}$/.test(currency)) await back("Pick a currency from the list.");

  repo.updateOpening(openingId, {
    title,
    salaryMin,
    salaryMax,
    salaryCurrency: currency,
    packageNotes: String(formData.get("packageNotes") ?? "").trim(),
    locations: list(formData.get("locations")),
    targetNationalities: list(formData.get("targetNationalities")),
    headcount: Math.max(1, Number(formData.get("headcount") ?? 1) || 1),
    priorityTier: String(formData.get("priorityTier") ?? "P3") as PriorityTier,
  });
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function deleteJobPost(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { post: "postId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  repo.deleteJobPost(String(formData.get("postId")));
  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function deleteLink(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { link: "entryId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  repo.deleteLink(String(formData.get("entryId")));
  revalidatePath(`/openings/${openingId}/hh`, "layout");
}

export async function removeApplication(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { application: "appId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const r = repo.removeApplication(String(formData.get("appId")));
  if (!r.ok) await back(r.message);
  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(`/openings/${openingId}`);
}

/** Finding 13 — the edit and remove controls on a candidate's contact details. */
export async function updateCandidateContact(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { opening: "openingId", candidate: "candidateId" });
  const openingId = String(formData.get("openingId"));
  const field = String(formData.get("field")) as "email" | "phone";
  if (field !== "email" && field !== "phone") return;
  const raw = String(formData.get("value") ?? "").trim();
  repo.updateCandidateContact(String(formData.get("candidateId")), { [field]: raw || null });
  revalidatePath(`/openings/${openingId}`, "layout");
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
  const user = await authorize(formData, "opening.act", { application: "appId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const appId = String(formData.get("appId"));

  const date = String(formData.get("date") ?? "").trim();
  const time = String(formData.get("time") ?? "").trim();
  if (!date || !time) await back("An interview needs a date and a time.");

  // Read as Colombo time, not the server's zone — a server in another region
  // would otherwise shift every interview and every reminder (audit finding 16).
  const scheduledAt = colomboLocalToInstant(`${date}T${time}`);
  if (scheduledAt === null) return back("That date or time could not be read.");

  const booked = repo.scheduleInterview({
    applicationId: appId,
    scheduledAt,
    timezone: String(formData.get("timezone") ?? "Asia/Colombo"),
    location: String(formData.get("location") ?? "").trim(),
    mode: String(formData.get("mode") ?? "in_person") as "in_person" | "video" | "phone",
    interviewers: String(formData.get("interviewers") ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean),
    durationMins: Number(formData.get("durationMins")) || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
    byUserId: user.id,
  });
  if (!booked.ok) await back(booked.message);

  revalidatePath(`/openings/${openingId}`, "layout");
}

export async function confirmInterview(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { interview: "interviewId", opening: "openingId" });
  repo.confirmInterview(String(formData.get("interviewId")));
  revalidatePath(`/openings/${String(formData.get("openingId"))}`, "layout");
  revalidatePath("/alerts");
}

/** How it went, which is a different fact from whether they turned up. */
export async function setInterviewResult(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { interview: "interviewId", opening: "openingId" });
  const rating = String(formData.get("clientRating") ?? "").trim();
  repo.setInterviewResult(String(formData.get("interviewId")), {
    result: String(formData.get("result") ?? "pending") as
      | "pending"
      | "passed"
      | "failed"
      | "on_hold",
    clientRating: rating ? Number(rating) : null,
    clientFeedback: String(formData.get("clientFeedback") ?? "").trim() || null,
  });
  revalidatePath(`/openings/${String(formData.get("openingId"))}`, "layout");
}

export async function setInterviewOutcome(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.act", { interview: "interviewId", opening: "openingId" });
  repo.setInterviewOutcome(
    String(formData.get("interviewId")),
    String(formData.get("outcome")) as "attended" | "no_show" | "cancelled",
  );
  revalidatePath(`/openings/${String(formData.get("openingId"))}`, "layout");
  revalidatePath("/alerts");
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
  if (!name || !spec) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    return;
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
  await primeStore({ allApplications: true });
  await authorize(formData, "report.read");
  const question = String(formData.get("question") ?? "").trim();
  if (!question) return;
  const { askForReport } = await import("@/lib/reportAsk");
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

export async function addUser(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const actor = await getCurrentUser();
  if (actor.role !== "admin" && actor.role !== "director") return;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  repo.addUser({
    name,
    email: String(formData.get("email") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim() || null,
    routingEmail: String(formData.get("routingEmail") ?? "").trim().toLowerCase() || null,
    role: String(formData.get("role") ?? "ta") as import("@/data/types").Role,
  });
  revalidatePath("/people");
}

export async function updateUser(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const actor = await getCurrentUser();
  if (actor.role !== "admin" && actor.role !== "director") return;
  repo.updateUser(String(formData.get("userId")), {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim() || null,
    routingEmail: String(formData.get("routingEmail") ?? "").trim().toLowerCase() || null,
    role: String(formData.get("role") ?? "ta") as import("@/data/types").Role,
  });
  revalidatePath("/people");
}

export async function setUserActive(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const actor = await getCurrentUser();
  if (actor.role !== "admin" && actor.role !== "director") return;
  repo.setUserActive(String(formData.get("userId")), String(formData.get("active")) === "1");
  revalidatePath("/people");
}

export async function signOut() {
  await primeStore({ allApplications: true });
  const { cookies } = await import("next/headers");
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/signin");
}

/**
 * Sign in as an account. Stage-one auth: no password, but a signed cookie and
 * a deliberate act, so that signing out stays signed out.
 */
export async function signInAs(formData: FormData) {
  await primeStore({ allApplications: true });
  const id = String(formData.get("userId") ?? "");
  const user = repo.users().find((u) => u.id === id);
  if (!user || !user.isActive) redirect("/signin");
  const { cookies } = await import("next/headers");
  (await cookies()).set(SESSION_COOKIE, sessionValue(user.id), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}

// ─── Database search (spec §6D) ──────────────────────────────────────────────

/** Run a search: the sentence goes in the URL, the parser does the rest. */
export async function runDatabaseSearch(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "database.read");
  const q = String(formData.get("q") ?? "").trim();
  const mode = String(formData.get("mode") ?? "natural");
  const openingId = String(formData.get("openingId") ?? "");
  if (!q) redirect("/database");
  const params = new URLSearchParams({ q });
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
  if (!query) return;

  const { isConvex } = await import("@/data/mode");
  if (isConvex()) {
    // Persist to Convex DB so saved searches survive server restarts.
    const { convexActorForEmail, convexMutation } = await import("@/lib/convexServer");
    const actor = await convexActorForEmail(user.email);
    if (actor) {
      await convexMutation("ta/search:saveSearch", {
        actorId: actor._id,
        name,
        query,
        mode,
        openingId: openingId ?? null,
        count,
      });
    }
  } else {
    repo.saveSearch({ name, query, mode, ownerId: user.id, openingId, count });
  }
  revalidatePath("/database", "layout");
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
      await convexMutation("ta/search:deleteSearch", { actorId: actor._id, searchId });
    }
  } else {
    repo.deleteSearch(searchId);
  }
  revalidatePath("/database", "layout");
}

/** Put a database candidate onto an opening — lands at Matched, unclaimed. */
export async function addToOpening(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const candidateId = String(formData.get("candidateId"));
  const openingId = String(formData.get("openingId"));
  if (!openingId) await back("Pick an opening.");
  const r = repo.addCandidateToOpening(candidateId, openingId, user.id);
  revalidatePath("/database", "layout");
  revalidatePath(`/candidates/${candidateId}`);
  revalidatePath(`/openings/${openingId}`, "layout");
  if (!r.ok) await back(r.reason ?? "Could not add them.");
  await back("Added as a database match.");
}

// ─── Headhunting intelligence (spec §8A) ─────────────────────────────────────


function contextFor(openingId: string): OpeningContext | null {
  const o = repo.opening(openingId);
  if (!o) return null;
  const client = repo.client(o.clientId);
  const brief = o.briefId ? repo.brief(o.briefId) : null;
  return {
    title: o.title,
    clientName: client?.name ?? "the client",
    industry: client?.industry ?? "",
    locations: o.locations,
    packageNotes: o.packageNotes,
    mustHaves: brief?.extracted?.mustHaves ?? [],
  };
}

export async function runResearch(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const res = await researchOpening(openingId, user.id);
  if (!res.ok) redirect(`/openings/${openingId}/hh/research?err=${res.reason}`);
  revalidatePath(`/openings/${openingId}/hh/research`);
}

export async function runBenchmark(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const o = repo.opening(openingId);
  if (!o) return;
  const client = repo.client(o.clientId);
  // Searches, then a cheap sort of what they returned: every named person and
  // link comes from a result. The older path let a model name people and could
  // attach an unrelated source to them (13 September review).
  const run = await benchmarkViaSearch(
    {
      title: o.title,
      clientName: client?.name ?? "the client",
      clientCompanyNames: [client?.name ?? ""].filter(Boolean),
      jdText: o.jdMarkdown || o.title,
      locations: o.locations,
      targetNationalities: o.targetNationalities,
      targetGender: o.targetGender,
      salaryNote: o.packageNotes,
      targetEmployers: [],
      alreadyKnown: repo.suggestions(openingId).map((x) => canonicalProfile(x.linkedinUrl ?? "")).filter((x): x is string => Boolean(x)),
    },
    openingId,
  );
  if (run.error) redirect(`/openings/${openingId}/hh/research?err=${run.error}`);
  repo.replaceBenchmarks(openingId, run.rows);
  redirect(`/openings/${openingId}/hh/research?found=${run.rows.length}&searches=${run.queries.length}${run.note ? `&note=${run.note}` : ""}`);
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
async function sourceFor(openingId: string, forUserId?: string): Promise<{ found: number; scanned: number; queries: number; cost: number; rejected?: number; note?: string; error?: string }> {
  const o = repo.opening(openingId);
  if (!o) return { found: 0, scanned: 0, queries: 0, cost: 0, error: "no_opening" };
  const client = repo.client(o.clientId);
  const existing = repo.suggestions(openingId);
  const round = existing.length ? Math.max(...existing.map((s) => s.round)) + 1 : 1;
  if (round > MAX_ROUNDS) return { found: 0, scanned: 0, queries: 0, cost: 0, error: "rounds_spent" };

  const alreadyKnown = [
    ...repo.linkVault(openingId).map((l) => canonicalProfile(l.linkedinUrl)),
    ...existing.map((s) => canonicalProfile(s.linkedinUrl ?? "")),
  ].filter((x): x is string => Boolean(x));

  const run = await runSourcing(
    {
      title: o.title,
      clientName: client?.name ?? "the client",
      clientCompanyNames: [client?.name ?? ""].filter(Boolean),
      jdText: o.jdMarkdown || o.title,
      locations: o.locations,
      targetNationalities: o.targetNationalities,
      targetGender: o.targetGender,
      salaryNote: o.packageNotes,
      targetEmployers: repo.benchmarks(openingId).filter((b) => b.isSelected).map((b) => b.company),
      alreadyKnown,
    },
    round,
  );
  if (run.error) return { found: 0, scanned: run.scanned, queries: run.queries.length, cost: run.cost, error: run.error };
  // A run belongs to whoever asked for it — see lib/visibility.
  repo.addSuggestions(
    openingId,
    run.suggestions.map((s) => ({ ...s, openingId, generatedFor: forUserId ?? null, keptBy: null })),
  );
  return {
    found: run.suggestions.length, scanned: run.scanned,
    queries: run.queries.length, cost: run.cost,
    rejected: run.rejected ?? 0, note: run.note,
  };
}

export async function runSuggestions(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const r = await sourceFor(openingId, user.id);
  if (r.error) redirect(`/openings/${openingId}/hh/suggestions?err=${r.error}`);
  const q = new URLSearchParams({
    found: String(r.found), scanned: String(r.scanned),
    queries: String(r.queries), cost: r.cost.toFixed(3),
    rejected: String(r.rejected ?? 0),
    ...(r.note ? { note: r.note } : {}),
  });
  redirect(`/openings/${openingId}/hh/suggestions?${q.toString()}`);
}

/** Keeping a profile sends it to the link vault, where the approach is logged. */
export async function keepSuggestion(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.sourcing", { suggestion: "suggestionId", opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const id = String(formData.get("suggestionId"));
  const s = repo.suggestions(openingId).find((x) => x.id === id);
  if (!s) return;
  repo.setSuggestionStatus(id, "kept", "more_like_this", user.id);
  if (s.linkedinUrl) {
    const entryId = repo.addLink(openingId, s.linkedinUrl, user.id);
    repo.updateLink(entryId, { name: s.name, title: s.headline, company: s.company });
  }
  revalidatePath(`/openings/${openingId}/hh`, "layout");
}

export async function dismissSuggestion(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { suggestion: "suggestionId", opening: "openingId" });
  repo.setSuggestionStatus(String(formData.get("suggestionId")), "dismissed", "not_relevant");
  revalidatePath(`/openings/${String(formData.get("openingId"))}/hh/suggestions`);
}

/** Spec §5.2 — the model writes it, the TA still approves it. */
/**
 * Write the JD draft for an opening, from its brief. The TA reads and approves
 * it; nothing here approves anything. Used by the button, and automatically the
 * moment an opening is created.
 */
async function draftJd(openingId: string): Promise<{ ok: boolean; reason?: string } | null> {
  const opening = repo.opening(openingId);
  const c = contextFor(openingId);
  if (!opening || !c) return null;
  const brief = opening.briefId ? repo.brief(opening.briefId) : null;
  const client = repo.client(opening.clientId);
  const extracted = brief?.extracted ?? { ...EMPTY_EXTRACT, title: opening.title };

  repo.applyExtractedToOpening(openingId, extracted);
  const template = buildJd(extracted, client?.name ?? "the client");

  const res = await generateJdText(c, brief?.notesMarkdown ?? "", template);
  // The template is not a failure state — it is what the desk has always had.
  repo.updateJd(openingId, res.ok ? res.text : template);
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}

/** Market research for an opening, keeping any field a TA corrected by hand. */
async function researchOpening(openingId: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
  const c = contextFor(openingId);
  const o = repo.opening(openingId);
  if (!c || !o) return { ok: false, reason: "missing" };
  const res = await generateResearch(c);
  if (!res.ok) return { ok: false, reason: res.reason };
  const prior = repo.research(openingId);
  const fields = { ...parseResearch(res.text) };
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
    markdown: res.text,
    sources: toCitations(res.sources),
    searches: res.searches,
    model: aiStatus().model,
    generatedBy: userId,
    generatedAt: Date.now(),
  });
  return { ok: true };
}

export async function generateJdWithModel(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.manage", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const res = await draftJd(openingId);
  if (!res) return;
  redirect(
    `/openings/${openingId}/jd?msg=${encodeURIComponent(
      res.ok
        ? "Written by the model. Read it before approving."
        : `The model could not write it — ${res.reason}. The template version is in place.`,
    )}`,
  );
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
  await primeStore({ allApplications: true });
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
    await back("Pick how the call went.");
  }
  const when = String(formData.get("promisedAt") ?? "").trim();
  const r = repo.recordCallOutcome({
    applicationId: appId,
    outcome,
    promisedAt: when ? colomboLocalToInstant(when) : null,
    note: String(formData.get("note") ?? ""),
    byUserId: user.id,
  });
  if (!r.ok) await back(r.message);
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

export async function setAutoShortlistScore(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "user.manage");
  const n = Math.round(Number(formData.get("score")));
  if (!Number.isFinite(n) || n < 40 || n > 100) await back("Pick a score between 40 and 100.");
  repo.setSetting("autoShortlistScore", String(n));
  revalidatePath("/", "layout");
  await back(`Pre-shortlist score set to ${n}.`);
}

// ─── Database matches (13 September) ────────────────────────────────────────

export async function findMatchesNow(formData: FormData) {
  await primeStore({ allApplications: true });
  await authorize(formData, "opening.sourcing", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const r = await findDatabaseMatches(openingId, "manual");
  revalidatePath(`/openings/${openingId}`, "layout");
  if (!r.ok || !r.run) {
    await back(r.reason === "jd_not_approved" ? "Approve the JD first — matching reads it." : `Matching did not run (${r.reason}).`);
  }
  await back(`${r.run!.added} added from ${r.run!.considered} nearest; ${r.run!.afterRules} passed the rules.`);
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

const num = (fd: FormData, k: string): number | null => {
  const raw = String(fd.get(k) ?? "").replace(/[^\d.]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** A date typed into a form, as 09:00 Colombo on that day — not the server's zone. */
const day = (fd: FormData, k: string): number | null => {
  const v = String(fd.get(k) ?? "").trim();
  return v ? colomboLocalToInstant(`${v}T09:00`) : null;
};

export async function makeOffer(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = repo.makeOffer({
    applicationId: appId,
    salary: num(formData, "salary") ?? 0,
    salaryBasis: String(formData.get("salaryBasis") ?? "monthly") as "monthly" | "annual",
    currency: String(formData.get("currency") ?? "LKR") as "LKR" | "USD",
    startDate: day(formData, "startDate"),
    terms: String(formData.get("terms") ?? "").trim() || null,
    byUserId: user.id,
  });
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  revalidatePath("/placements");
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function respondToOffer(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", offer: "offerId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const r = repo.respondToOffer({
    offerId: String(formData.get("offerId")),
    status: String(formData.get("status")) as "accepted" | "declined" | "withdrawn",
    reason: String(formData.get("reason") ?? ""),
    byUserId: user.id,
  });
  revalidatePath(`/openings/${openingId}/candidate/${appId}`);
  revalidatePath("/placements");
  redirect(
    `/openings/${openingId}/candidate/${appId}${r.ok ? "" : `?msg=${encodeURIComponent(r.message)}`}`,
  );
}

export async function recordPlacement(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { application: "applicationId", opening: "openingId" });
  const appId = String(formData.get("applicationId"));
  const openingId = String(formData.get("openingId"));
  const joinDate = day(formData, "joinDate");
  if (joinDate === null)
    redirect(
      `/openings/${openingId}/candidate/${appId}?msg=${encodeURIComponent("A placement needs a join date.")}`,
    );
  const r = repo.recordPlacement({
    offerId: String(formData.get("offerId")),
    joinDate,
    salary: num(formData, "salary") ?? undefined,
    byUserId: user.id,
  });
  revalidatePath("/placements");
  if (!r.ok)
    redirect(`/openings/${openingId}/candidate/${appId}?msg=${encodeURIComponent(r.message)}`);
  redirect(`/placements/${r.id}`);
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

export async function sendEod(formData: FormData) {
  await primeStore({ allApplications: true });
  const user = await authorize(formData, "opening.act", { opening: "openingId" });
  const openingId = String(formData.get("openingId"));
  const kind = String(formData.get("kind") ?? "director") as "director" | "client";
  const ids = String(formData.get("applicationIds") ?? "").split(",").filter(Boolean);

  // Anybody already sent to this reviewer is dropped, and so is anybody who is
  // not on this opening — the list came from the browser.
  const sent = new Set(repo.reviewRounds(openingId).filter((r) => r.kind === kind).flatMap((r) => r.applicationIds));
  const fresh = ids.filter((id) => !sent.has(id) && repo.application(id)?.openingId === openingId);
  if (fresh.length === 0)
    redirect(`/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(
      ids.length ? "Everyone on that list has already been sent." : "Nothing to send.",
    )}`);
  const sets = fresh.map((id) => repo.application(id)?.setNumber).filter((n): n is number => n != null);
  // Anyone sent to the Director straight out of a finished follow-up moves to
  // Director Review now — the email going out is that move.
  if (kind === "director") {
    for (const id of fresh) {
      if (repo.application(id)?.stage === "follow_up") {
        repo.moveStage(id, "director_review", user.id, "Sent to the Director in the end-of-day email");
      }
    }
  }

  repo.openReviewRound({
    openingId,
    kind,
    applicationIds: fresh,
    setNumber: sets.length ? Math.min(...sets) : null,
    sentBy: user.id,
    sentTo: String(formData.get("to") ?? ""),
    // The address the reply is watched on: copied in, and on the reply-to.
    trackedAt: repo.shortlistInbox(),
    subject: String(formData.get("subject") ?? ""),
  });

  revalidatePath(`/openings/${openingId}`, "layout");
  redirect(
    `/openings/${openingId}/eod?kind=${kind}&msg=${encodeURIComponent(
      `Recorded as sent to the ${kind}. ${fresh.length} ${fresh.length === 1 ? "person is" : "people are"} now waiting on a reply. Nothing was emailed from here.`,
    )}`,
  );
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
  const { parseReply } = await import("@/lib/reviewReply");
  const list = roster.applicationIds.map((applicationId) => {
    const app = repo.application(applicationId);
    const c = app ? repo.candidate(app.candidateId) : null;
    return { applicationId, name: c?.fullName ?? "Unknown" };
  });
  const parsed = await parseReply(body, list);
  const decided = parsed.decisions.filter((d) => d.outcome !== "hold");

  if (decided.length === 0) {
    return parsed.unmatched.length
      ? `Nobody has been moved — read this part yourself: ${parsed.unmatched.join(" · ")}`
      : "Nothing in that reply could be read as a decision. Nobody has been moved — say who is in, by name or by number.";
  }

  const res = repo.applyReviewDecisions(round.id, parsed.decisions.map((d) => ({ ...d, confirmed: false })), body);
  revalidatePath(`/openings/${openingId}`, "layout");
  revalidatePath("/alerts");
  const stillWaiting = repo.waitingOn(openingId, kind).filter((w) => w.roundId === round.id).length;
  const older = roster.openRounds - 1;
  return `${res.moved} shortlisted, ${res.rejected} passed over${
    res.stale ? `, ${res.stale} not moved because they have moved on since` : ""
  }${res.repeated ? `, ${res.repeated} already recorded` : ""}${
    stillWaiting > 0 ? `. ${stillWaiting} in this email not decided yet — still waiting` : ""
  }${older > 0 ? `. ${older} earlier email${older === 1 ? " is" : "s are"} still open — read ${older === 1 ? "its" : "their"} replies against ${older === 1 ? "it" : "them"}` : ""}${
    parsed.unmatched.length ? `. Read yourself: ${parsed.unmatched.join(" · ")}` : ""
  }.`;
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

  if (!from || !body) back("Needs at least who it came from and what they said.");

  const { classifyInbound, matchReviewReply } = await import("@/lib/routing");

  // Belt and braces: if it arrived at one of our addresses, it must be the
  // shortlist box. A CV that wandered in here is not a decision about anybody.
  const to = String(formData.get("to") ?? "").trim();
  if (to) {
    const kindOf = classifyInbound(to, repo.users(), repo.shortlistInbox());
    if (kindOf.kind === "application")
      back("That came to an applications inbox, not the shortlist box — it is a CV, not a decision.");
    if (kindOf.kind === "not_ours") back(`Nothing of ours receives at ${to}.`);
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
  if (!target.round) back(`Could not place that reply. ${target.note}`);
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
