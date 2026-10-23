import { repo, setsForOpening } from "@/data/store";
import { CLOSED_STAGES, PIPELINE_STAGES, STAGE_LABEL, type Application, type Stage, type User } from "@/data/types";
import { allows, isTa } from "@/lib/auth";
import { colomboDaysBetween } from "@/lib/calendar";
import type { FitBand, PipelineCandidate, PipelinePayload, PipelineStage } from "@/lib/mobile/pipelineTypes";
import { ALLOWED_TRANSITIONS } from "@/lib/pipeline";
import { seatFor, visibleToSeat } from "@/lib/visibility";
import { inWorkLocation, workLocationView } from "@/lib/workLocations";

export const MOBILE_PIPELINE_STAGES = [...PIPELINE_STAGES, ...CLOSED_STAGES] as PipelineStage[];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function fitBand(score: number | null): FitBand {
  if (score === null) return "unknown";
  if (score >= 75) return "strong";
  if (score >= 60) return "possible";
  return "low";
}

function tagsOf(app: Application): string[] {
  return [
    app.isAddOn ? "Add-on" : null,
    app.backupForApplicationId ? "Backup" : null,
    app.sourcingChannel === "HH" ? "HH" : null,
    !app.ownerTaId ? "Unclaimed" : null,
  ].filter((tag): tag is string => Boolean(tag));
}

/** The same seat and work-location slice as the web stage page, as phone data. */
export function mobilePipeline(
  user: User,
  openingId: string,
  stage: PipelineStage,
  requestedWorkLocation?: string,
  now = Date.now(),
): PipelinePayload | null {
  const opening = repo.opening(openingId);
  if (!opening || !MOBILE_PIPELINE_STAGES.includes(stage)) return null;
  const client = repo.client(opening.clientId);
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  const seat = seatFor(user, assignment?.role ?? null, onStrategy);
  if (seat.stages !== null && !seat.stages.includes(stage as Stage)) return null;

  let workLocationId: string | undefined;
  try {
    workLocationId = workLocationView(opening, requestedWorkLocation);
  } catch {
    return null;
  }
  const visible = visibleToSeat(repo.applications(openingId), seat).filter((app) => inWorkLocation(app, workLocationId));
  const atStage = visible.filter((app) => app.stage === stage);
  const users = repo.users();
  const canAct = allows(user, "opening.act", { openingId, assignment, onStrategy });
  const canManage = allows(user, "opening.manage", { openingId, assignment, onStrategy });

  const candidates: PipelineCandidate[] = atStage.flatMap((app) => {
    const candidate = repo.candidate(app.candidateId);
    if (!candidate) return [];
    const owner = app.ownerTaId ? users.find((row) => row.id === app.ownerTaId) : undefined;
    const locked = Boolean(app.ownerTaId && app.ownerTaId !== user.id && isTa(user));
    const score = typeof app.matchScore === "number" ? app.matchScore : null;
    return [{
      applicationId: app.id,
      candidateId: candidate.id,
      name: candidate.fullName,
      initials: initials(candidate.fullName),
      currentTitle: candidate.currentTitle,
      currentEmployer: candidate.currentEmployer,
      location: candidate.location,
      experienceYears: candidate.totalExperienceYears,
      noticeDays: candidate.noticePeriodDays,
      ownerName: owner?.name ?? null,
      fitScore: score,
      fitBand: fitBand(score),
      fitReasons: app.matchReason ? [app.matchReason] : [],
      tags: tagsOf(app),
      waitingDays: colomboDaysBetween(app.lastStageChangedAt, now),
      hasCv: Boolean(candidate.cvFileName || app.cvFileName),
      lockedBy: locked ? owner?.name ?? "another recruiter" : null,
      canCall: canAct && !locked && Boolean(candidate.phone?.replace(/\D/g, "")),
      canEmail: canAct && !locked && Boolean(candidate.email),
      allowedStages: canAct && !locked
        ? (ALLOWED_TRANSITIONS[app.stage] ?? []).filter((next): next is PipelineStage => MOBILE_PIPELINE_STAGES.includes(next as PipelineStage))
        : [],
    }];
  });

  const stageCounts = visible.reduce((counts, app) => {
    counts[app.stage] = (counts[app.stage] ?? 0) + 1;
    return counts;
  }, {} as Partial<Record<Stage, number>>);
  const oldest = [...atStage].sort((a, b) => a.lastStageChangedAt - b.lastStageChangedAt)[0];
  const tags = [...new Set(candidates.flatMap((candidate) => candidate.tags))].sort();
  const locations = [...new Set(candidates.map((candidate) => candidate.location).filter((value): value is string => Boolean(value)))].sort();
  const workLocations = (opening.workLocations ?? []).filter((row) => !row.archived).map((row) => ({ id: row.id, name: row.name }));

  return {
    apiVersion: 1,
    opening: {
      id: opening.id,
      title: opening.title,
      clientName: client?.name ?? "",
      positionCode: opening.positionCode ?? null,
      workLocations,
    },
    activeStage: stage,
    activeWorkLocationId: workLocationId ?? null,
    stages: MOBILE_PIPELINE_STAGES
      .filter((item) => seat.stages === null || seat.stages.includes(item as Stage))
      .map((item) => ({ stage: item, label: STAGE_LABEL[item], count: stageCounts[item] ?? 0 })),
    candidates,
    stats: {
      atStage: atStage.length,
      setsClosed: setsForOpening(openingId, seat.ownDeskOf ?? undefined).filter((set) => set.status === "closed").length,
      longestWaitingDays: oldest ? colomboDaysBetween(oldest.lastStageChangedAt, now) : null,
    },
    filters: { locations, tags },
    followUp: stage === "ta_follow_up" || stage === "ai_follow_up"
      ? {
          autoFollowUp: opening.autoFollowUp,
          standardQuestions: repo.followUpStandard().filter((question) => question.enabled).map((question) => question.label),
          customQuestions: opening.followUpQuestions.map((question) => question.label),
          canManage,
          canUploadCv: stage === "ta_follow_up" && canAct && workLocationId !== "",
        }
      : null,
  };
}

