import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { setupChecks, researchMissing, researchVersion, linkedinPostUrl, RESEARCH_LABELS, workSessionStart, SUGGESTIONS_WORKDAY_REQUIRED } from "../../src/lib/workdayRequirements";
import type { WorkdayCheck } from "../../src/lib/workday";
import { linkKey } from "../../src/lib/url";

export async function requiredChecks(ctx: QueryCtx | MutationCtx, day: Doc<"taWorkdays">, entry: Doc<"taWorkdays">["jobs"][number]) {
  const [notes, research, posts, links, suggestions, runs, apps, receipts, rounds, provenance, job] = await Promise.all([
    ctx.db.query("taWorkdayCheckNotes").withIndex("by_user_job", q => q.eq("userId", day.userId).eq("jobId", entry.jobId)).first(),
    ctx.db.query("researchReports").withIndex("by_opening", q => q.eq("openingId", entry.jobId)).first(),
    ctx.db.query("jobPosts").withIndex("by_opening", q => q.eq("openingId", entry.jobId)).collect(),
    ctx.db.query("linkVault").withIndex("by_workday_added", q => q.eq("openingId", entry.jobId).eq("addedBy", day.userId)).collect(),
    ctx.db.query("profileSuggestions").withIndex("by_opening", q => q.eq("openingId", entry.jobId)).collect(),
    ctx.db.query("taSourcingRuns").withIndex("by_job", q => q.eq("jobId", entry.jobId)).collect(),
    ctx.db.query("applications").withIndex("by_workday_owner", q => q.eq("jobId", entry.jobId).eq("ownerTaId", day.userId)).collect(),
    ctx.db.normalizeId("taWorkdays", day._id) ? ctx.db.query("taWorkdayMail").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", entry.jobId)).collect() : Promise.resolve([]),
    ctx.db.query("reviewRounds").withIndex("by_opening", q => q.eq("openingId", entry.jobId)).collect(),
    ctx.db.query("taWorkdayEvidence").withIndex("by_job", q => q.eq("jobId", entry.jobId)).collect(),
    ctx.db.get(entry.jobId),
  ]);
  const applicable = suggestions.filter(s => !s.generatedFor || s.generatedFor === day.userId);
  const latestRun = runs.filter(r => !r.userId || r.userId === day.userId).sort((a,b) => b.at - a.at)[0];
  const round = Math.max(latestRun?.round ?? 0, ...applicable.map(s => s.round));
  const latest = applicable.filter(s => s.round === round);
  const suggestionVersion = JSON.stringify([round, latestRun?.at ?? null, latest.map(s => [s._id, s.generatedAt])]);
  const goodPosts = posts.filter(p => linkedinPostUrl(p.externalUrl));
  const post = goodPosts.sort((a,b) => (a.postedAt ?? a.createdAt) - (b.postedAt ?? b.createdAt))[0];
  const postEvidence = post ? provenance.filter(p => p.table === "jobPosts" && p.recordId === post._id && p.version === post.externalUrl).sort((a,b) => b.at-a.at)[0] : undefined;
  const suggestionEvidence = provenance.filter(p => p.table === "profileSuggestions" && latest.some(s => s._id === p.recordId && s.status === p.version)).sort((a,b) => b.at-a.at)[0];
  const unique = [...new Map(links.filter(l => !!linkKey(l.linkedinUrl)).sort((a,b) => b.createdAt-a.createdAt)
    .map(l => [linkKey(l.linkedinUrl) ?? l.linkedinUrl, l])).values()].sort((a,b) => a.createdAt-b.createdAt);
  const sentIds = new Set(rounds.filter(r => r.kind === "director").flatMap(r => r.applicationIds as string[]));
  const since = workSessionStart(entry);
  const accepted = receipts.filter(r => r.status === "accepted" && r.finalizedAt && (entry.workType !== "Add-on" || r.startedAt >= since));
  const ready = apps.filter(a => a.currentStage === "second_shortlist" && !sentIds.has(a._id) && (entry.workType !== "Add-on" || a.lastStageChangedAt >= since));
  const ownNotes = notes?.workdayId === day._id ? notes : null;
  const checks = setupChecks({ jobId: entry.jobId, workType: entry.workType, userId: day.userId,
    jd: { version: job?.jobDescription ?? "", approved: job?.jdStatus === "approved", reviewedVersion: notes?.jdVersion, at: notes?.jdReviewedAt, by: day.userId },
    post: post ? { id: post._id, at: postEvidence?.at ?? post.postedAt ?? undefined, by: postEvidence?.by } : undefined,
    research: { version: researchVersion(research), reviewedVersion: notes?.researchVersion,
      missing: researchMissing(research?.fields ?? {}, notes?.unavailableReasons ?? {}),
      unavailable: researchMissing(research?.fields ?? {}, {}).filter(key => notes?.unavailableReasons?.[key]?.trim()).map(key => `${RESEARCH_LABELS[key]} unavailable: ${notes!.unavailableReasons[key]}`),
      at: notes?.researchReviewedAt, by: day.userId },
    suggestions: { successful: !!latestRun || latest.length > 0, pending: latest.filter(s => s.status === "new").length,
      count: latest.length, version: suggestionVersion, emptyReason: notes?.emptySuggestionsVersion === suggestionVersion ? notes.emptySuggestionsReason : undefined,
      at: latest.length ? suggestionEvidence?.at : notes?.emptySuggestionsAt, by: latest.length ? suggestionEvidence?.by : day.userId },
    profiles: { count: unique.length, at: unique[2]?.createdAt }, ready: ready.length,
    submitted: new Set(accepted.flatMap(r => r.applicationIds as string[])).size,
    noCandidateReason: entry.workType !== "Add-on" || (ownNotes?.noCandidateAt ?? 0) >= since ? ownNotes?.noCandidateReason : undefined,
    noCandidateAt: ownNotes?.noCandidateAt,
    chatgptLink: ownNotes?.chatgptLink ?? accepted.at(-1)?.researchLink,
    confirmedAt: ownNotes?.confirmedAt ?? accepted.at(-1)?.acceptedAt,
    emailAt: accepted.length ? Math.min(...accepted.map(r => r.finalizedAt!)) : undefined,
  }, true);
  const suggestionsCheck = checks.find(c => c.key.startsWith("suggestions:")) ?? null;
  const candidateCheck = checks.find(c => c.key.startsWith("director_candidate:"));
  if (candidateCheck?.status === "complete" && ready.length && !accepted.length) {
    candidateCheck.completedAt = Math.min(...ready.map(a => a.lastStageChangedAt));
    candidateCheck.evidence = ready.map(a => a._id).join(",");
  }
  return { checks: SUGGESTIONS_WORKDAY_REQUIRED ? checks : checks.filter(c => !c.key.startsWith("suggestions:")),
    suggestionsCheck, notes, research, suggestionVersion, latest, latestRun, job };
}

/** Editing shared text invalidates every TA's review, including when old text is restored. */
export async function invalidateJdReviews(ctx: MutationCtx, jobId: Id<"jobs">) {
  const notes = await ctx.db.query("taWorkdayCheckNotes").withIndex("by_job", q => q.eq("jobId", jobId)).collect();
  for (const note of notes) if (note.jdVersion !== undefined) await ctx.db.patch(note._id, { jdVersion: undefined });
}

export async function recordJdReview(ctx: MutationCtx, userId: Id<"users">, jobId: Id<"jobs">, version: string) {
  const notes = await ctx.db.query("taWorkdayCheckNotes").withIndex("by_user_job", q => q.eq("userId", userId).eq("jobId", jobId)).first();
  const patch = { jdVersion: version, jdReviewedAt: notes?.jdVersion === version ? notes.jdReviewedAt ?? Date.now() : Date.now() };
  if (notes) await ctx.db.patch(notes._id, patch);
  else await ctx.db.insert("taWorkdayCheckNotes", { userId, jobId, ...patch });
}

/** Event reads never manufacture a completion time for legacy evidence. */
export async function withTaskHistory(ctx: QueryCtx | MutationCtx, day: Doc<"taWorkdays">, jobId: Id<"jobs">, checks: WorkdayCheck[]) {
  const events = await ctx.db.query("taWorkdayTaskEvents").withIndex("by_workday_job", q => q.eq("workdayId", day._id).eq("jobId", jobId)).collect();
  const names = new Map<string, string>();
  for (const id of new Set([...events.flatMap(e => [e.by, e.completedBy].filter(Boolean)), ...checks.map(c => c.completedBy).filter(Boolean)])) {
    const normalized = ctx.db.normalizeId("users", id!);
    const user = normalized ? await ctx.db.get(normalized) : null;
    if (user) names.set(id!, user.fullName);
  }
  const current = new Set(checks.map(c => c.key));
  for (const event of events) if (!current.has(event.key) && event.key.includes(":")) {
    // Historical events must not put the paused requirement back in the sidebar.
    if (!SUGGESTIONS_WORKDAY_REQUIRED && event.key.startsWith("suggestions:")) continue;
    current.add(event.key);
    checks.push({ key: event.key, jobId, label: event.label, href: event.href, kind: event.kind as WorkdayCheck["kind"],
      canCarry: false, evidenceAt: 0, status: "complete" });
  }
  return checks.map(c => {
    const history = events.filter(e => e.key === c.key).sort((a,b) => a.at-b.at);
    const last = history.at(-1);
    const same = last?.status === c.status;
    return { ...c, completedAt: same && c.status === "complete" ? last?.completedAt ?? c.completedAt : c.completedAt,
      completedBy: names.get(c.completedBy ?? "") ?? c.completedBy ?? (same ? names.get(last?.completedBy ?? "") ?? last?.completedBy : undefined),
      events: history.map(e => ({ status: e.status, at: e.at, by: names.get(e.by ?? ""), evidence: e.evidence, observed: e.observed })) };
  });
}
