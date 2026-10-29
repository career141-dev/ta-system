import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import { FAILURE_MESSAGE } from "@/lib/ai";
import { isTa } from "@/lib/auth";
import type { User } from "@/data/types";
import { convexMutation } from "@/lib/convexServer";
import { reviseJdText } from "@/lib/headhunt";
import { extractFromText, EMPTY_EXTRACT } from "@/lib/intake";
import { chatHistory, detailsFollowNotes, JD_REQUEST_MAX } from "@/lib/jdChat";
import { contextFor, draftJd, jdBriefsFor } from "@/lib/openings/jdDraft";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";
import { safeErrorMessage } from "@/lib/userError";
import * as backend from "@/data/convex/backend";
import type { JdDetailsBody } from "@/lib/mobile/jdTypes";

export type JdWriteOutcome =
  | { ok: true; message: string; tone?: "ok" | "note"; reextracting?: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500 | 502; message: string };

export interface JdWriteDeps extends Pick<OpeningWriteDeps, "convexQuery"> {
  markTablesStale: () => void;
  resetStore: () => void;
}

async function mayWrite(user: User, openingId: string, deps: JdWriteDeps) {
  return decideOn(user, "opening.manage", { openingId }, deps);
}

/** Save one person's notes without replacing the lead's or another TA's brief. */
export function saveOwnJdNotes(openingId: string, userId: string, notes: string): boolean {
  const opening = repo.opening(openingId);
  if (!opening) return false;
  const extracted = notes.trim() ? { ...extractFromText(notes), title: opening.title } : { ...EMPTY_EXTRACT, title: opening.title };
  const mine = repo.briefsForOpening(openingId).filter((row) => row.capturedBy === userId).at(-1);
  if (mine) {
    if (mine.notesMarkdown !== notes) repo.updateBrief(mine.id, { notesMarkdown: notes, extracted });
    return true;
  }
  if (!notes.trim()) return true;
  repo.createBrief({
    clientId: opening.clientId, openingId, kind: "lead_to_ta", capturedBy: userId, capturedAt: Date.now(), method: "notes",
    notesMarkdown: notes, transcriptStatus: "none", transcript: null, recordingKey: null, recordingDurationMs: null,
    consentAcknowledgedBy: null, consentAcknowledgedAt: null, consentText: null, extracted,
  });
  return true;
}

export async function writeJdNotes(user: User, openingId: string, notes: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  if (!saveOwnJdNotes(openingId, user.id, notes)) return { ok: false, status: 404, message: "The opening could not be found, so the notes were not saved. Reload the page and try again." };
  return { ok: true, message: "Notes saved." };
}

export async function generateJd(user: User, openingId: string, notes: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  saveOwnJdNotes(openingId, user.id, notes);
  const result = await draftJd(openingId, user.id);
  if (!result) return { ok: false, status: 404, message: "The opening could not be found. Reload the page and try again." };
  if (isConvex()) deps.resetStore();
  if (result.ok) return { ok: true, message: "Written by the AI. Read it through before approving." };
  return { ok: true, tone: "note", message: `The AI could not write it — ${reasonInWords(result.reason)} A basic version built from your notes is in place: try again, or edit it by hand.` };
}

export async function approveJdText(user: User, openingId: string, markdown: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  const approvedMarkdown = markdown.trim() || repo.opening(openingId)?.jdMarkdown || "";
  if (!approvedMarkdown.trim()) return { ok: false, status: 400, message: "Add the job description before approving it." };
  if (isConvex()) {
    try {
      await backend.approveJd({ id: user.id }, openingId, approvedMarkdown, !detailsFollowNotes(repo.jdChat(openingId)));
      deps.markTablesStale();
      deps.resetStore();
    } catch (error) {
      return { ok: false, status: 502, message: safeErrorMessage(error, "The JD could not be approved.") };
    }
  } else {
    repo.updateJd(openingId, approvedMarkdown);
    repo.approveJd(openingId, user.id);
  }
  return { ok: true, reextracting: isConvex(), message: "The job description is approved. The job is live." };
}

export async function amendJdText(user: User, openingId: string, markdown: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  const opening = repo.opening(openingId);
  if (!opening) return { ok: false, status: 404, message: "The opening could not be found. Reload the page and try again." };
  if (!opening.assignedTaIds.includes(user.id) && isTa(user)) return { ok: false, status: 403, message: "Only an assigned TA can amend this JD." };
  if (!markdown.trim()) return { ok: false, status: 400, message: "Add the job description before saving it." };
  if (isConvex()) {
    try {
      const result = await convexMutation<{ reextracting: boolean }>("ta/openings:saveJd", { actorId: user.id, openingId, jdMarkdown: markdown });
      deps.markTablesStale();
      deps.resetStore();
      return { ok: true, reextracting: result.reextracting, message: result.reextracting ? "JD saved. The job details are read again, then matching re-runs." : "JD saved." };
    } catch (error) {
      return { ok: false, status: 502, message: safeErrorMessage(error, "The JD could not be saved.") };
    }
  }
  repo.updateJd(openingId, markdown);
  return { ok: true, message: "JD saved." };
}

async function saveChatJd(openingId: string, userId: string, markdown: string, deps: JdWriteDeps): Promise<boolean> {
  const opening = repo.opening(openingId);
  if (isConvex()) {
    const result = await convexMutation<{ reextracting: boolean }>("ta/openings:saveJd", {
      actorId: userId, openingId, jdMarkdown: markdown,
      ...(opening?.jdStatus === "approved" ? { detailsFromJd: true } : {}),
    });
    if (result.reextracting) deps.markTablesStale();
    deps.resetStore();
    return result.reextracting;
  }
  repo.updateJd(openingId, markdown);
  return false;
}

export async function reviseJd(user: User, openingId: string, request: string, currentMarkdown: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  const instruction = request.trim();
  if (!instruction) return { ok: false, status: 400, message: "Write what should change in the JD first." };
  if (instruction.length > JD_REQUEST_MAX) return { ok: false, status: 400, message: `That is too long — keep it under ${JD_REQUEST_MAX} characters.` };
  const opening = repo.opening(openingId);
  const context = contextFor(openingId);
  if (!opening || !context) return { ok: false, status: 404, message: "The opening could not be found. Reload the page and try again." };
  const current = currentMarkdown.trim() || opening.jdMarkdown || "";
  if (!current.trim()) return { ok: false, status: 400, message: "There is no JD to revise yet. Generate one first." };
  const history = chatHistory(repo.jdChat(openingId));
  repo.addJdChat({ openingId, role: "user", body: instruction, jdMarkdown: null, byUserId: user.id, at: Date.now() });
  const result = await reviseJdText(context, jdBriefsFor(openingId), current, instruction, history);
  if (!result.ok || !result.text.trim()) {
    repo.addJdChat({ openingId, role: "assistant", jdMarkdown: null, byUserId: null, at: Date.now(), failed: true, body: `Could not revise the JD — ${result.ok ? "the AI sent back nothing." : reasonInWords(result.reason)} The JD is as it was. Try again.` });
    return { ok: false, status: 502, message: "Could not revise the JD. The JD is as it was — try again." };
  }
  const changes = result.changes || "Revised the JD.";
  repo.addJdChat({ openingId, role: "assistant", body: changes, jdMarkdown: result.text, byUserId: null, at: Date.now() });
  let reextracting = false;
  try { reextracting = await saveChatJd(openingId, user.id, result.text, deps); }
  catch (error) { return { ok: false, status: 502, message: safeErrorMessage(error, "The revised JD could not be saved. Try again.") }; }
  return { ok: true, reextracting, message: `Revised: ${changes}` };
}

export async function restoreJd(user: User, openingId: string, messageId: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  const turn = repo.jdChat(openingId).find((row) => row.id === messageId);
  if (!turn?.jdMarkdown) return { ok: false, status: 404, message: "That version could not be found. Reload the page and try again." };
  const time = new Date(turn.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" });
  repo.addJdChat({ openingId, role: "assistant", body: `Put back the version from ${time}.`, jdMarkdown: turn.jdMarkdown, byUserId: user.id, at: Date.now() });
  let reextracting = false;
  try { reextracting = await saveChatJd(openingId, user.id, turn.jdMarkdown, deps); }
  catch (error) { return { ok: false, status: 502, message: safeErrorMessage(error, "That version could not be put back. Try again.") }; }
  return { ok: true, reextracting, message: `Put back the version from ${time}.` };
}

export async function saveJdDetails(user: User, openingId: string, details: JdDetailsBody, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  if (!isConvex()) return { ok: false, status: 409, message: "Job details need the Convex store." };
  if (details.experienceMaxYears !== null && details.experienceMaxYears < details.experienceMinYears) {
    return { ok: false, status: 400, message: "Maximum experience cannot be less than minimum experience." };
  }
  if (details.salaryMin !== null && details.salaryMax !== null && details.salaryMax < details.salaryMin) {
    return { ok: false, status: 400, message: "Maximum salary cannot be less than minimum salary." };
  }
  try {
    await convexMutation("ta/requirements:save", {
      actorId: user.id, openingId, title: details.title, clientIndustry: details.clientIndustry,
      recruitmentType: details.recruitmentType, isConfidential: details.isConfidential, status: details.jobStatus,
      location: details.location, seniorityLevel: details.seniorityLevel, experienceMinYears: details.experienceMinYears,
      experienceMaxYears: details.experienceMaxYears, educationLevel: details.educationLevel, salaryMin: details.salaryMin,
      salaryMax: details.salaryMax, salaryCurrency: details.salaryCurrency, requiredSkills: details.requiredSkills,
      niceToHaveSkills: details.niceToHaveSkills, languagesRequired: details.languagesRequired,
    });
    deps.markTablesStale();
    deps.resetStore();
  } catch (error) {
    return { ok: false, status: 502, message: safeErrorMessage(error, "The job details could not be saved.") };
  }
  return { ok: true, reextracting: true, message: "Job details saved. Matching is re-running against them." };
}

export async function reextractJdDetails(user: User, openingId: string, deps: JdWriteDeps): Promise<JdWriteOutcome> {
  const decision = await mayWrite(user, openingId, deps);
  if (!decision.ok) return decision;
  try {
    await convexMutation("ta/requirements:reextract", { actorId: user.id, openingId });
    deps.markTablesStale();
    deps.resetStore();
  } catch (error) {
    return { ok: false, status: 502, message: safeErrorMessage(error, "Could not start the extraction.") };
  }
  return { ok: true, reextracting: true, message: "Reading the JD again — the details update in a few seconds." };
}

function reasonInWords(reason: string | undefined): string {
  const sentence = reason && (FAILURE_MESSAGE as Record<string, string>)[reason];
  return sentence ?? (reason ? `${reason}.` : "no reason was given.");
}
