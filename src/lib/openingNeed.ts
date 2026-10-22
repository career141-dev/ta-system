/**
 * The one line under each of a TA's openings on the home dashboard: what the
 * role needs from them next. The web card (src/app/page.tsx) prints `text`;
 * the mobile home (src/lib/mobile/home.ts) sends both, so the two read the
 * same and cannot drift. Checked in this order — the first that applies wins.
 */
export type OpeningNeed =
  | { kind: "jd_approval"; text: string }
  | { kind: "low_cvs"; text: string }
  | { kind: "open_set"; text: string }
  | { kind: "on_track"; text: string };

export function openingNeed(input: {
  jdStatus: string;
  cvsToday: number;
  openSet: { setNumber: number; count: number } | undefined;
}): OpeningNeed {
  const { jdStatus, cvsToday, openSet } = input;
  if (jdStatus === "pending_ta_approval") return { kind: "jd_approval", text: "The JD is waiting for your approval" };
  if (cvsToday < 10) return { kind: "low_cvs", text: `Only ${cvsToday} CVs today — under the ten a day line` };
  if (openSet) return { kind: "open_set", text: `Set ${openSet.setNumber} needs ${5 - openSet.count} more to close` };
  return { kind: "on_track", text: "On track" };
}
