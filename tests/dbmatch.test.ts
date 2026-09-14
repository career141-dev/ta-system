/**
 * Search by meaning and the automatic database matches. Runs on the no-key
 * word-hashing stand-in, so nothing leaves the machine; what is tested is the
 * pipeline around the vectors — strict filters, limits, exclusions — which is
 * the same whichever model makes them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "C141_EMBED_MODEL"]) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-match-"));
process.chdir(tmp);

const { repo } = await import("@/data/store");
const { cosine, embedModel, localVector, LOCAL_MODEL, _resetVectorCache } = await import("@/lib/embed");
const { failsHardRules, findDatabaseMatches, LIMITS, requirementsFor } = await import("@/lib/dbMatch");
const { locationFit } = await import("@/lib/places");
const { criteriaFromParams } = await import("@/lib/query");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nvectors");
eq("with no key the stand-in is used, and says so", embedModel(), LOCAL_MODEL);
const a = localVector("Brand Manager leading trade marketing for FMCG brands");
const b = localVector("Senior brand manager, FMCG, trade marketing and brand plans");
const c = localVector("Warehouse supervisor, forklift operations and stock counts");
eq("similar work is closer than different work", cosine(a, b) > cosine(a, c), true);
eq("a text is identical to itself", Math.round(cosine(a, a) * 1000) / 1000, 1);

console.log("\nsearch by meaning keeps the strict filters strict");
repo.reset();
const everyone = repo.candidates();
const allClose = new Map(everyone.map((x) => [x.id, 0.9]));
const colombo = repo.searchDatabase(criteriaFromParams({ locations: "Colombo" }), { similarity: allClose, floor: 0.25, limit: 10_000 });
eq("the location filter is still applied", colombo.total > 0 && colombo.total < everyone.length && colombo.results.every((r) => (r.candidate.location ?? "").toLowerCase() === "colombo"), true);
const words = criteriaFromParams({ titles: "Warehouse Supervisor" });
const byMeaning = repo.searchDatabase(words, { similarity: allClose, floor: 0.25, limit: 10_000 });
eq("by words, that title finds few", repo.searchDatabase(words, { limit: 10_000 }).total < everyone.length, true);
eq("by meaning, the words stop filtering — similarity ranks instead", byMeaning.total, everyone.length);
const half = new Map(everyone.map((x, i) => [x.id, i % 2 ? 0.9 : 0.1]));
eq("below the floor is not a result", repo.searchDatabase(criteriaFromParams({}), { similarity: half, floor: 0.25, limit: 10_000 }).total, Math.floor(everyone.length / 2));
const ranked = repo.searchDatabase(criteriaFromParams({}), { similarity: new Map(everyone.map((x, i) => [x.id, 0.3 + i / (everyone.length * 2)])), floor: 0.25, limit: 3 });
eq("the closest come first", ranked.results[0].candidate.id, everyone[everyone.length - 1].id);

console.log("\nautomatic matches");
repo.reset();
_resetVectorCache();
const opening = repo.opening("op_gmmerc")!;
const req = requirementsFor(opening.id)!;
const before = new Set(repo.applications(opening.id).map((x) => x.candidateId));
const waitingBefore = repo.applications(opening.id).filter((x) => x.stage === "matched" && !x.ownerTaId).length;

const r = await findDatabaseMatches(opening.id, "manual");
eq("it runs on an approved JD", r.ok, true);
const run = r.run!;
eq("and finds people to add", run.added > 0, true);
eq("it looks at no more than 300", run.considered <= LIMITS.nearest, true);
const added = repo.applications(opening.id).filter((x) => !before.has(x.candidateId));
eq("what it says it added is what was added", added.length, run.added);
eq("a standing list of 30 at most", waitingBefore + run.added <= LIMITS.shown, true);
eq("they arrive as unclaimed database matches", added.every((x) => x.stage === "matched" && !x.ownerTaId && x.sourcingChannel === "SCOOP"), true);
eq("each says why it was matched", added.every((x) => /^Matched from the database on request — fit \d+/.test(x.notes[0] ?? "")), true);
eq(
  "nobody of a known, different nationality is added",
  added.every((x) => {
    const p = repo.candidate(x.candidateId)!;
    return !p.nationality || p.nationality === "Sri Lankan";
  }),
  true,
);
eq("nobody fails the experience floor", added.every((x) => failsHardRules(repo.candidate(x.candidateId)!, opening, req.minYears) === null), true);
eq("the run is recorded", repo.matchRuns(opening.id)[0]?.added, run.added);
eq("the run says it was not meaning-based", /not meaning/.test(repo.matchRuns(opening.id)[0]?.note ?? ""), true);

console.log("\nit does not bring back who was taken off, or pile up");
{
  const gone = added[0];
  repo.removeApplication(gone.id);
  eq("taking a match off records it", repo.matchExcluded(opening.id).has(gone.candidateId), true);
  await findDatabaseMatches(opening.id, "nightly");
  eq("and the next run leaves them off", repo.applications(opening.id).some((x) => x.candidateId === gone.candidateId), false);
}
const waitingNow = repo.applications(opening.id).filter((x) => x.stage === "matched" && !x.ownerTaId).length;
eq("never more than 30 waiting after another run", waitingNow <= LIMITS.shown, true);

console.log("\nhard rules");
const client = opening.clientId;
const someone = repo.candidates().find((p) => p.nationality === "Sri Lankan" && locationFit(opening.locations, p.location) === "match")!;
eq("a matching person passes", failsHardRules(someone, opening, null), null);
eq("the wrong nationality fails", failsHardRules({ ...someone, nationality: "Indian" }, opening, null), "nationality");
eq("a blank nationality is not a reason to hide someone", failsHardRules({ ...someone, nationality: null }, opening, null), null);
eq("another country does not exclude when the JD does not say local only", failsHardRules({ ...someone, location: "Dubai" }, opening, null), null);
eq("another city in the same country never excludes", failsHardRules({ ...someone, location: "Kandy" }, { ...opening, localOnly: true }, null), null);
eq("a blank location never excludes", failsHardRules({ ...someone, location: null }, { ...opening, localOnly: true }, null), null);
eq("local only: another country fails", failsHardRules({ ...someone, location: "Dubai" }, { ...opening, localOnly: true }, null), "location");
eq("clearly too few years fails", failsHardRules({ ...someone, totalExperienceYears: 2, workHistory: [] }, opening, 8), "years");
eq("a little under the floor stays in, ranked lower", failsHardRules({ ...someone, totalExperienceYears: 6, workHistory: [] }, opening, 8), null);
eq("a low parsed total does not hide a long career", failsHardRules({ ...someone, totalExperienceYears: 2, workHistory: [{ title: "Manager", employer: "X", fromYear: 2010, toYear: null }] }, opening, 8), null);
eq("unknown years is not a reason to hide someone", failsHardRules({ ...someone, totalExperienceYears: null }, opening, 8), null);
void client;

console.log("\nit waits for an approved JD");
eq("no JD, no matching", (await findDatabaseMatches("op_hobo", "manual")).reason, "jd_not_approved");
eq("an opening on hold is not matched", (await findDatabaseMatches("op_mktexe", "nightly")).reason, "not_open");
eq("vectors are kept beside the database", fs.existsSync(path.join(tmp, ".data", "vectors.json")), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
