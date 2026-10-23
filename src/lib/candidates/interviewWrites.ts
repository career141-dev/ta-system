import { colomboLocalToInstant } from "@/lib/calendar";
import { repo } from "@/data/store";
import type { InterviewRatingKey, User } from "@/data/types";
import { OUTCOME_FOR, mayChangeFeedback, whenLabel, type InterviewStatus } from "@/lib/interviews";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";

type Mode = "in_person" | "video" | "phone";
type Rating = 1 | 2 | 3 | 4 | 5 | null;

export type CandidateInterviewWrite =
  | { action: "schedule"; title: string; date: string; time: string; timezone: string; location: string; mode: Mode; interviewers: string[]; durationMins: number | null; notes: string }
  | { action: "confirm"; interviewId: string }
  | { action: "outcome"; interviewId: string; outcome: Exclude<InterviewStatus, "rescheduled">; reason: string }
  | { action: "result"; interviewId: string; result: "pending" | "passed" | "failed" | "on_hold"; clientRating: Rating; clientFeedback: string }
  | { action: "reschedule"; interviewId: string; date: string; time: string; location: string; mode: Mode; reason: string }
  | { action: "edit"; interviewId: string; title: string; interviewers: string[]; durationMins: number | null; notes: string }
  | {
      action: "feedback";
      interviewId: string;
      forUserId: string | null;
      interviewer: string;
      ratings: Record<InterviewRatingKey, Rating>;
      recommendation: "hire" | "next_round" | "hold" | "reject" | null;
      comments: string;
    };

export type CandidateInterviewResult =
  | { ok: true; message: string }
  | { ok: false; status: 400 | 403 | 404; message: string };

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Every web and native interview write passes through the same record and policy checks. */
export async function writeCandidateInterview(
  user: User,
  openingId: string,
  applicationId: string,
  input: CandidateInterviewWrite,
  deps: Pick<OpeningWriteDeps, "convexQuery" | "revalidatePath">,
): Promise<CandidateInterviewResult> {
  const opening = repo.opening(openingId);
  const app = repo.application(applicationId);
  if (!opening || !app || app.openingId !== opening.id) {
    return { ok: false, status: 404, message: "That candidate is not on this opening." };
  }

  const interview = input.action === "schedule" ? null : repo.interviews(applicationId).find((row) => row.id === input.interviewId) ?? null;
  if (input.action !== "schedule" && !interview) {
    return { ok: false, status: 404, message: "That interview no longer exists." };
  }

  const capability = input.action === "feedback" ? "interview.feedback" : "opening.act";
  const decision = await decideOn(user, capability, { openingId, ownerTaId: capability === "opening.act" ? app.ownerTaId : null }, deps);
  if (!decision.ok) return decision;

  let message = "Saved.";
  if (input.action === "schedule") {
    if (!input.date.trim() || !input.time.trim()) return { ok: false, status: 400, message: "An interview needs a date and a time." };
    const scheduledAt = colomboLocalToInstant(`${input.date.trim()}T${input.time.trim()}`);
    if (scheduledAt === null) return { ok: false, status: 400, message: "That date or time could not be read." };
    const wasInterviewing = app.stage === "interview";
    const booked = repo.scheduleInterview({
      applicationId,
      title: clean(input.title) || null,
      scheduledAt,
      timezone: input.timezone || "Asia/Colombo",
      location: clean(input.location),
      mode: input.mode,
      interviewers: input.interviewers.map(clean).filter(Boolean),
      durationMins: input.durationMins,
      notes: clean(input.notes) || null,
      byUserId: user.id,
    });
    if (!booked.ok) return { ok: false, status: 400, message: booked.message };
    message = `Interview booked for ${whenLabel(scheduledAt)}${wasInterviewing ? "" : " — moved to Interview"}.`;
  } else if (input.action === "confirm") {
    repo.confirmInterview(input.interviewId);
    message = "Attendance confirmed.";
  } else if (input.action === "outcome") {
    const outcome = OUTCOME_FOR[input.outcome];
    repo.setInterviewOutcome(input.interviewId, outcome, user.id, clean(input.reason) || null);
    message = "Interview status saved.";
  } else if (input.action === "result") {
    repo.setInterviewResult(input.interviewId, {
      result: input.result,
      clientRating: input.clientRating,
      clientFeedback: clean(input.clientFeedback) || null,
    });
    message = "Client verdict saved.";
  } else if (input.action === "reschedule") {
    if (!input.date.trim() || !input.time.trim()) return { ok: false, status: 400, message: "Rescheduling needs the new date and time." };
    const scheduledAt = colomboLocalToInstant(`${input.date.trim()}T${input.time.trim()}`);
    if (scheduledAt === null) return { ok: false, status: 400, message: "That date or time could not be read." };
    const moved = repo.rescheduleInterview(input.interviewId, {
      scheduledAt,
      location: clean(input.location),
      mode: input.mode,
      reason: clean(input.reason) || null,
      byUserId: user.id,
    });
    if (!moved.ok) return { ok: false, status: 400, message: moved.message };
    message = `Interview moved to ${whenLabel(scheduledAt)}. Confirm attendance again.`;
  } else if (input.action === "edit") {
    repo.editInterview(input.interviewId, {
      title: clean(input.title) || null,
      interviewers: input.interviewers.map(clean).filter(Boolean),
      durationMins: input.durationMins,
      notes: clean(input.notes) || null,
    }, user.id);
    message = "Interview details saved.";
  } else {
    const forUserId = input.forUserId || user.id;
    const existing = interview!.feedback.find((row) => row.byUserId === forUserId);
    if (forUserId !== user.id && !existing) return { ok: false, status: 404, message: "That feedback no longer exists." };
    if (!mayChangeFeedback(user, existing)) {
      return { ok: false, status: 403, message: "Only a lead, director or admin can change someone else's feedback." };
    }
    const comments = clean(input.comments) || null;
    if (!comments && Object.values(input.ratings).every((rating) => rating === null)) {
      return { ok: false, status: 400, message: "Give at least one score or a comment." };
    }
    repo.saveInterviewFeedback(input.interviewId, {
      byUserId: forUserId,
      interviewer: clean(input.interviewer) || existing?.interviewer || user.name,
      ratings: input.ratings,
      recommendation: input.recommendation,
      comments,
    });
    message = existing ? "Feedback updated." : "Feedback saved.";
  }

  deps.revalidatePath(`/openings/${openingId}`, "layout");
  if (["confirm", "outcome", "reschedule"].includes(input.action)) deps.revalidatePath("/alerts");
  return { ok: true, message };
}
