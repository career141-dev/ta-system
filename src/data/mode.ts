/**
 * Which store is behind `repo`.
 *
 * `convex` — the backend at CONVEX_SELF_HOSTED_URL, holding the real records.
 *            The only store the running app uses.
 * `json`   — an in-memory file store with seeded, synthetic data. Used by the
 *            unit tests, which are about the desk's rules and must run without
 *            a database, and by nothing else.
 *
 * It used to default to `json`, and when the setting was missing the app
 * quietly showed seeded people with @example.invalid addresses in place of the
 * real database. Now the JSON store is available only when the test runner
 * asks for it explicitly (tests/run.mjs sets both variables); anywhere else the
 * app is on Convex, and without a Convex configuration it fails with a message
 * saying so rather than showing invented data.
 */
export type StoreMode = "json" | "convex";

export function storeMode(): StoreMode {
  const asked = (process.env.C141_STORE ?? "").trim().toLowerCase();
  if (asked === "json" && process.env.C141_TEST_RUN === "1") return "json";
  return "convex";
}

export const isConvex = () => storeMode() === "convex";
