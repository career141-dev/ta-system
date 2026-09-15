import "server-only";

/**
 * The CV scanner's reads.
 *
 * The scanning itself — criteria expansion, extraction, the per-criterion
 * scoring and the verbatim evidence quotes — is `convex/cvScanner/*` and is
 * not touched. This is the platform's view of it.
 */

import { convexQuery } from "@/lib/convexServer";

export interface ScanSummary {
  id: string;
  title: string;
  criteria: string[];
  status: string;
  total: number;
  processed: number;
  matched: number;
  createdAt: number;
}

interface RawScan {
  _id: string;
  title: string;
  criteria: (string | { text: string })[];
  status: string;
  totalFiles: number;
  processedFiles: number;
  matchedFiles: number;
  createdAt: number;
}

/** Recent scans, newest first. */
export async function listScans(): Promise<ScanSummary[]> {
  try {
    const rows = await convexQuery<RawScan[]>("cvScanner/scanMutations:getUserScans", {});
    return rows.map((s) => ({
      id: s._id,
      title: s.title,
      // The criteria list holds both shapes: plain strings from the older
      // scans and `{ text, isLocation }` from the newer ones.
      criteria: (s.criteria ?? []).map((c) => (typeof c === "string" ? c : c.text)),
      status: s.status,
      total: s.totalFiles ?? 0,
      processed: s.processedFiles ?? 0,
      matched: s.matchedFiles ?? 0,
      createdAt: s.createdAt ?? 0,
    }));
  } catch {
    // A scanner that is not reachable is not a broken page: the screen says
    // there are no scans rather than failing to render.
    return [];
  }
}
