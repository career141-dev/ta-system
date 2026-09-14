import path from "node:path";

/**
 * Where this build keeps its data. `.data` by default; `C141_DATA_DIR` points
 * a separate copy elsewhere — the live-data test (13 September) runs in its own
 * folder so real CVs never mix with the invented seed data and can be deleted
 * in one go.
 */
export function dataDir(): string {
  const d = (process.env.C141_DATA_DIR ?? "").trim();
  return d ? path.resolve(d) : path.join(process.cwd(), ".data");
}
