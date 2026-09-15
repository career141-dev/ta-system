/**
 * Which store is behind `repo`.
 *
 * `json`   — the file at .data/db.json. Seeded, synthetic, offline.
 * `convex` — the backend at CONVEX_SELF_HOSTED_URL, holding the real records.
 *
 * The switch exists so the conversion can land a domain at a time without the
 * app being broken in between, and so the tests — which are about the desk's
 * rules, not about where rows are kept — keep running against the file.
 *
 * It defaults to `json`. A missing or misspelt setting must not silently point
 * the app at the live database.
 */
export type StoreMode = "json" | "convex";

export function storeMode(): StoreMode {
  return (process.env.C141_STORE ?? "").trim().toLowerCase() === "convex" ? "convex" : "json";
}

export const isConvex = () => storeMode() === "convex";
