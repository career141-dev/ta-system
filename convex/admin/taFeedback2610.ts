/**
 * The TAs' own pipeline tables, applied (owner, 26 October). Hassan, Sanduni
 * and Thushini each sent the Director-shortlisted, client-shortlisted,
 * interviewed and dropped-out people for their openings; cross-checked
 * against live the same day, these 31 were behind what the table says.
 *
 * Each moves only if it is still at the stage it was checked at — a TA who
 * has moved someone since wins. Never backwards, but for the one the
 * interviews@ catch-up put at Interview by mistake; nothing is sent. Run only
 * through the release pipeline, first dryRun=true and then dryRun=false.
 *
 *   run_function: admin/taFeedback2610:run
 *   run_args:     {"dryRun":true}
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { executeStageTransition, type PipelineStage } from "../pipeline/pipelineStateMachine";

const MOVES: { applicationId: string; from: string; to: PipelineStage; ta: string; who: string }[] = [
  { applicationId: "js79btyhx0j52sx932g1mb21ad8gs4ba", from: "second_shortlist", to: "director_shortlist", ta: "Hassan", who: "Akbar Brothers · Customer Experience Manager" },
  { applicationId: "js7cxt7f3kr0jppc01fwp7qgch8gnewc", from: "director_shortlist", to: "unresponsive", ta: "Hassan", who: "DeltaSpike · Business Growth Manager" },
  { applicationId: "js7ba9cdpjp0645a226tm2sghn8gnmkv", from: "director_shortlist", to: "client_review", ta: "Hassan", who: "DeltaSpike · Business Growth Manager" },
  { applicationId: "js7cxrpkz0mattvjpp4xcmx5dx8g9r8a", from: "ta_shortlist", to: "client_review", ta: "Hassan", who: "DeltaSpike · FINANCE MANAGER" },
  { applicationId: "js76yd5s3zckn5hm03j8aym5e98gav4e", from: "new_cvs", to: "client_review", ta: "Hassan", who: "BALPP · HEAD OF ACADEMIC" },
  { applicationId: "js73q26b0pw4wec4wb64jhjpr18gkswg", from: "second_shortlist", to: "client_review", ta: "Hassan", who: "SQ - BD · General Manager - Innovation & Operations" },
  { applicationId: "js74sx2s055wdfb4vjv2ceeevh8gk9ff", from: "second_shortlist", to: "director_shortlist", ta: "Hassan", who: "SQ - BD · General Manager - Innovation & Operations" },
  { applicationId: "js78m23d426pe5kjy99km5qarh8gj74d", from: "second_shortlist", to: "client_review", ta: "Hassan", who: "SQ - BD · General Manager - Innovation & Operations" },
  { applicationId: "js78j48ywcfy0arj5rzfk5x0ed8gj927", from: "second_shortlist", to: "director_shortlist", ta: "Hassan", who: "SQ - BD · General Manager - Innovation & Operations" },
  { applicationId: "js7fz4f7v4nx0vpqqt7h3fm9z58ftqt0", from: "interview", to: "unresponsive", ta: "Sanduni", who: "Silver Bullet · Head of Electrical" },
  { applicationId: "js75ata0dmjfne511tmrh67kax8ftd16", from: "new_cvs", to: "director_shortlist", ta: "Sanduni", who: "Silver Bullet · Head of Electrical" },
  { applicationId: "js73n606h2f5ms3xab00n8yncs8gjwbx", from: "follow_up", to: "director_shortlist", ta: "Sanduni", who: "PGP · Head of Manufacturing Excellence" },
  { applicationId: "js79gbbq973awmfz06rz5g4vfx8gc0pk", from: "second_shortlist", to: "director_shortlist", ta: "Sanduni", who: "PGP · Head of Manufacturing Excellence" },
  { applicationId: "js7761sbrmwxkkd8gd77pmw3k18g5rpa", from: "director_shortlist", to: "interview", ta: "Sanduni", who: "Q COLLECTION (SL) · Senior Executive - Electrical" },
  { applicationId: "js7a1te018xc5j2y1qajrzbd6h8g5p1q", from: "director_shortlist", to: "interview", ta: "Sanduni", who: "Q COLLECTION (SL) · Senior Executive - Electrical" },
  { applicationId: "js7btervtrsyb9b1sx8ykrtbsn8gwkj4", from: "new_cvs", to: "director_shortlist", ta: "Sanduni", who: "FGL Vietnam · Head of Cutting" },
  { applicationId: "js74abvjmp3ce6k8cnznf0fv7d8gb1jx", from: "matched_candidates", to: "client_review", ta: "Thushini", who: "Silver Bullet · FINANCE MANAGER" },
  { applicationId: "js7dg5atddwray1swtqe6c2bfd8gp3k2", from: "director_shortlist", to: "interview", ta: "Thushini", who: "Silver Bullet · FINANCE MANAGER" },
  { applicationId: "js71wdetykqyjpwyfkn4kxg7tn8g5ak1", from: "follow_up", to: "director_shortlist", ta: "Thushini", who: "Silver Bullet · FINANCE MANAGER" },
  { applicationId: "js7dkq40sppkw1keqajm7sybm58gq5mv", from: "new_cvs", to: "interview", ta: "Thushini", who: "Silver Bullet · FINANCE MANAGER" },
  { applicationId: "js72ab0qb5hrbch3pkb4a9ekz18gcy4w", from: "ta_shortlist", to: "director_shortlist", ta: "Thushini", who: "Q COLLECTION (SL) · MANAGER HR" },
  { applicationId: "js76zpa24awg9xx8th8zxmrffd8gdgtw", from: "new_cvs", to: "director_shortlist", ta: "Thushini", who: "Q COLLECTION (SL) · MANAGER HR" },
  { applicationId: "js70bpn9y29sjqqr91w1175p9h8gb8kg", from: "ta_shortlist", to: "director_shortlist", ta: "Thushini", who: "Q COLLECTION (SL) · MANAGER HR" },
  { applicationId: "js74thp273q7g4g1p37zaajznd8gqvg8", from: "second_shortlist", to: "interview", ta: "Thushini", who: "MELWA · Head OF HR" },
  { applicationId: "js7298kf9nndgvhqxhfv96sjsd8gpg7w", from: "second_shortlist", to: "director_shortlist", ta: "Thushini", who: "MELWA · Head OF HR" },
  { applicationId: "js75qf97yj2w90eph2yrhtdt8x8gqjpd", from: "second_shortlist", to: "director_shortlist", ta: "Thushini", who: "MELWA · Head OF HR" },
  { applicationId: "js7asgg8sr3s10hnnsa0yqzww58gy8v8", from: "matched_candidates", to: "director_shortlist", ta: "Thushini", who: "MELWA · Head OF HR" },
  { applicationId: "js749wps01rn0wynxzd6yrcfed8fxsex", from: "new_cvs", to: "director_shortlist", ta: "Thushini", who: "DELMO - HOLDING · IT MANAGER" },
  { applicationId: "js7axxt7dtfyy5bt93ah1w1rh98fx24z", from: "new_cvs", to: "director_shortlist", ta: "Thushini", who: "DELMO - HOLDING · IT MANAGER" },
  { applicationId: "js77g8b52xbrrkydhjkge5m7sx8fvtzc", from: "matched_candidates", to: "director_shortlist", ta: "Thushini", who: "DELMO - HOLDING · IT MANAGER" },
  { applicationId: "js7faw8cf8c1hcdj1rd6hjvnnd8frapn", from: "new_cvs", to: "unresponsive", ta: "Thushini", who: "DELMO - HOLDING · IT MANAGER" },
  // Added after the first run: on Melwa Head of HR too, not only Group Head
  // of HR (two positions, owner 26 Oct). His second record there is left.
  { applicationId: "js7a3zk2hf6mjhmhnjsw32kx2x8g9w07", from: "matched_candidates", to: "director_shortlist", ta: "Thushini", who: "MELWA · Head OF HR" },
  // Moved to Interview by the interviews@ catch-up that morning because the
  // invitation went to his address; Thushini's table names a different
  // candidate of the same first name as the one interviewed (moved above).
  // Back to where he was.
  { applicationId: "js769bdp4kpby0ng5ant2c306x8gvhzn", from: "interview", to: "ta_shortlist", ta: "Thushini", who: "MELWA · Head OF HR (back from Interview)" },
];

const LABEL: Record<string, string> = {
  ta_shortlist: "TA shortlist", director_shortlist: "Director shortlist", client_review: "Client shortlist", interview: "Interview", unresponsive: "Dropped out",
};

/**
 * One move, in its own transaction. The first real run did all of them in one
 * mutation and the backend stopped it at its one-second limit — nothing was
 * changed (26 October) — so each is its own, and the action walks the list.
 */
export const moveOne = internalMutation({
  args: { applicationId: v.string(), from: v.string(), to: v.string(), ta: v.string(), dryRun: v.boolean() },
  handler: async (ctx, m): Promise<string> => {
    const app = await ctx.db.get(m.applicationId as Id<"applications">);
    const now = app?.currentStage ?? "missing";
    if (!app || now !== m.from) return `skipped — now at ${now}`;
    if (m.dryRun) return "would move";
    await executeStageTransition(ctx, {
      applicationId: app._id,
      targetStage: m.to as PipelineStage,
      actorId: "ta-feedback",
      reason: m.to === "unresponsive"
        ? `Dropped out — ${m.ta}'s pipeline table, 26 Oct`
        : `${LABEL[m.to]} per ${m.ta}'s pipeline table, 26 Oct`,
      bypassRoleCheck: true,
      skipAutoOutreach: true,
      decidedByReviewer: true,
    });
    return "moved";
  },
});

export const run = internalAction({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const rows: { who: string; from: string; to: string; result: string }[] = [];
    for (const m of MOVES) {
      let result: string;
      try {
        result = await ctx.runMutation(internal.admin.taFeedback2610.moveOne, { applicationId: m.applicationId, from: m.from, to: m.to, ta: m.ta, dryRun: args.dryRun });
      } catch (e) {
        result = `error — ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
      rows.push({ who: m.who, from: m.from, to: m.to, result });
    }
    const summary: Record<string, number> = {};
    for (const r of rows) summary[r.result.replace(/ —.*/, "")] = (summary[r.result.replace(/ —.*/, "")] ?? 0) + 1;
    return { dryRun: args.dryRun, summary, rows };
  },
});
