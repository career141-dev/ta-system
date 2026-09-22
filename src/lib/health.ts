/**
 * Two derived facts the platform was missing.
 *
 * Both are computed, never stored, for the same reason the SLA alerts are: a
 * stored number goes stale the moment somebody acts, and a dashboard showing
 * yesterday's position is worse than one showing none.
 */

import type { Application, Opening, Stage } from "@/data/types";
import { PRIORITY_TARGET } from "@/data/types";

// ─────────────────────────────────────────────── where a candidate really is ──

/**
 * The furthest a candidate has got on ANY job, not just the one you are
 * looking at.
 *
 * Without it a person placed on another role still reads as available in
 * search, and a TA spends a morning on somebody who started somewhere else
 * last week. The live system calls this `overallStatus`.
 */
const RANK: Stage[] = [
  "placed", "offer", "interview", "client_shortlist", "director_shortlist",
  "director_review", "ta_follow_up", "ai_follow_up", "matched",
  "new_cv", "dropped_out", "rejected",
];

export function overallStatus(apps: Application[]): {
  stage: Stage | null;
  openingId: string | null;
  /** True when they are committed elsewhere — placed, offered or interviewing. */
  busy: boolean;
} {
  if (apps.length === 0) return { stage: null, openingId: null, busy: false };
  let best = apps[0];
  for (const a of apps) {
    if (RANK.indexOf(a.stage) < RANK.indexOf(best.stage)) best = a;
  }
  return {
    stage: best.stage,
    openingId: best.openingId,
    busy: ["placed", "offer", "interview"].includes(best.stage),
  };
}

// ──────────────────────────────────────────────────── is this role on track ──

export type HealthBand = "good" | "slipping" | "stuck";

export interface Health {
  score: number;
  band: HealthBand;
  /** The parts, so the number can be argued with rather than believed. */
  parts: { label: string; score: number; note: string }[];
  /** The single most useful sentence about this role. */
  headline: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * One number for whether a role is on track, out of four things that actually
 * go wrong: nothing coming in, nothing being screened, nothing moving up, and
 * running out of time.
 */
export function healthFor(input: {
  opening: Opening;
  apps: Application[];
  cvsToday: number;
  livePosts: number;
  now?: number;
}): Health {
  const now = input.now ?? Date.now();
  const { opening: o, apps } = input;
  const at = (s: Stage) => apps.filter((a) => a.stage === s).length;

  // 1. Are CVs arriving at all?
  const flow = input.livePosts === 0 ? 40 : clamp((input.cvsToday / 10) * 100);

  // 2. Is anyone reading them?
  const waiting = at("new_cv") + at("matched");
  const screening = waiting === 0 ? 100 : clamp(100 - waiting * 4);

  // 3. Is anything reaching a decision-maker?
  const upstream = at("new_cv") + at("matched") + at("ai_follow_up") + at("ta_follow_up");
  const downstream =
    at("director_review") + at("director_shortlist") + at("client_shortlist") +
    at("interview") + at("offer") + at("placed");
  const progress = upstream + downstream === 0 ? 50 : clamp((downstream / (upstream + downstream)) * 140);

  // 4. How much of the clock is gone?
  const days = Math.floor((now - (o.assignedAt ?? now)) / 86_400_000);
  const target = PRIORITY_TARGET[o.priorityTier].days;
  const time = clamp(100 - (days / target) * 100);

  const parts = [
    { label: "CVs arriving", score: flow, note: input.livePosts === 0 ? "No advert is live" : `${input.cvsToday} today` },
    { label: "Being screened", score: screening, note: `${waiting} unread` },
    { label: "Reaching a decision", score: progress, note: `${downstream} past the TA` },
    { label: "Time left", score: time, note: `day ${days} of ${target}` },
  ];

  const score = clamp(flow * 0.2 + screening * 0.25 + progress * 0.35 + time * 0.2);
  const band: HealthBand = score >= 65 ? "good" : score >= 40 ? "slipping" : "stuck";

  // The headline names the worst part, because that is the thing to fix.
  const worst = [...parts].sort((a, b) => a.score - b.score)[0];
  const headline =
    band === "good"
      ? "On track."
      : worst.label === "CVs arriving"
        ? input.livePosts === 0
          ? "Nothing is advertised, so nothing is coming in."
          : "Too few CVs arriving."
        : worst.label === "Being screened"
          ? `${waiting} CVs waiting to be read.`
          : worst.label === "Reaching a decision"
            ? "Plenty in, nothing getting past the TA."
            : `Day ${days} of ${target} and not filled.`;

  return { score, band, parts, headline };
}
