/**
 * The read-only link to the current system, against a stand-in server that
 * answers like Convex's HTTP API. Proves what it may and may not call.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]) delete process.env[k];
process.env.C141_EMBED_MODEL = "openai/text-embedding-3-small@1024";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-live-"));
process.chdir(tmp);

const { ReadOnlyConvex, READ_FUNCTIONS, LiveReadError } = await import("@/lib/live/readOnlyConvex");
const { ReadOnlyQdrant } = await import("@/lib/live/readOnlyQdrant");
const { mapCandidate, yearOf } = await import("@/lib/live/mapLive");
const { checkLive, syncLive } = await import("@/lib/live/sync");
const { repo } = await import("@/data/store");
const { ensureVectors, candidateVector } = await import("@/lib/embed");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// ─── A stand-in for the live backend ────────────────────────────────────────
const KEY = "rotated-admin-key-for-tests-only";
const vec = (seed: number, width = 1024) => Array.from({ length: width }, (_, i) => Math.sin(seed * 7.1 + i * 0.37));
const PLACEHOLDER = vec(999);
const resumes = Array.from({ length: 60 }, (_, i) => ({
  _id: `r${i}`,
  candidateId: `c${i}`,
  rawText: i % 10 === 7 ? "" : `Senior accountant with audit experience number ${i}. `.repeat(3),
  ...(i % 10 === 7 ? { rawTextKey: `cvs/${i}.txt` } : {}),
  embedding: i >= 57 ? PLACEHOLDER : i === 3 || i === 4 ? vec(i, 1536) : vec(i),
  hasEmbedding: true,
  jobHistory: [{ company: "Acme", title: "Auditor", startDate: "Jan 2018", endDate: "Present" }],
}));
const candidateDoc = (id: string) => ({
  _id: id, _creationTime: 1_780_000_000_000, fullName: `Person ${id}`, email: `${id}@example.invalid`, phone: null,
  currentJobTitle: "Senior Accountant", currentEmployer: "Acme", totalExperienceYears: 8, skills: ["IFRS", { value: "Audit" }],
  industries: ["Finance"], education: [{ degree: "BSc Accounting", institution: "Colombo" }], certifications: ["ACCA"],
  expectedSalary: 350000, expectedSalaryCurrency: "LKR", location: "Colombo",
});

const calls: { method: string; url: string; auth: string; path?: string }[] = [];
let failNext: number[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : {};
    calls.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ""), path: j.path });
    const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    if (failNext.length) return send(failNext.shift()!, { status: "error", errorMessage: "busy" });
    if (req.url !== "/api/query") return send(200, { status: "success", value: "SHOULD NEVER BE CALLED" });
    if (req.headers.authorization !== `Convex ${KEY}`) return send(401, { status: "error", errorMessage: "bad key" });
    if (j.path === READ_FUNCTIONS.resumesPage) {
      const start = j.args.cursor ? Number(j.args.cursor) : 0;
      const page = resumes.slice(start, start + j.args.limit);
      const next = start + j.args.limit;
      return send(200, { status: "success", value: { page, isDone: next >= resumes.length, continueCursor: String(next) } });
    }
    if (j.path === READ_FUNCTIONS.candidatesByIds) return send(200, { status: "success", value: j.args.candidateIds.map(candidateDoc) });
    return send(200, { status: "error", errorMessage: `Could not find function ${j.path}` });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const client = (rate = 50) => new ReadOnlyConvex({ url, adminKey: KEY, rate, retries: 3 });

console.log("\nit can only read");
const c1 = client();
eq("there is no way to call a mutation or an action", [typeof (c1 as any).mutation, typeof (c1 as any).action], ["undefined", "undefined"]);
let refused = "";
try { await c1.query("candidates/candidates:deleteCandidate" as any, {}); } catch (e) { refused = (e as Error).message; }
eq("a function not on the read list is refused", /not on the read-only list/.test(refused), true);
eq("…before any request is sent", calls.length, 0);
await c1.query(READ_FUNCTIONS.resumesPage, { limit: 5, cursor: null });
eq("reads go to /api/query only, as POST", calls.every((c) => c.url === "/api/query" && c.method === "POST"), true);
eq("with the key as Convex expects", calls[0].auth, `Convex ${KEY}`);
eq("the read list holds only query functions", Object.values(READ_FUNCTIONS), ["matching/queries:getPaginatedResumesWithEmbeddings", "matching/queries:getCandidatesBatchPublic", "jobs/jobs:getActiveJobsBasicInfo", "jobs/jobs:getJob", "candidates/candidates:getCandidatesForJob", "stats/statsQueries:getCandidatesPage", "stats/statsQueries:getCvUploadsPage", "stats/statsQueries:getApplicationsPage", "stats/statsQueries:getJobsPage", "jobs/jobs:getJobCounts", "jobs/jobs:listPaginated", "candidates/candidates:fetchBatchForDeletion", "applications/applications:getApplication"]);

console.log("\nit is gentle with a busy server");
calls.length = 0;
const slow = client(10);
const t0 = Date.now();
for (let i = 0; i < 5; i++) await slow.query(READ_FUNCTIONS.resumesPage, { limit: 1, cursor: null });
eq("five requests at 10 a second take at least 0.4 s", Date.now() - t0 >= 400, true);
const par = client(10);
const t1 = Date.now();
await Promise.all(Array.from({ length: 4 }, () => par.query(READ_FUNCTIONS.resumesPage, { limit: 1, cursor: null })));
eq("requests made together still go one at a time", Date.now() - t1 >= 300, true);
failNext = [503, 429];
calls.length = 0;
const retried = await client().query<{ page: unknown[] }>(READ_FUNCTIONS.resumesPage, { limit: 2, cursor: null });
eq("backs off and retries when busy", [retried.page.length, calls.length], [2, 3]);
let keyLeak = "";
try { await new ReadOnlyConvex({ url, adminKey: "wrong-key-value", rate: 50, retries: 0 }).query(READ_FUNCTIONS.resumesPage, { limit: 1, cursor: null }); } catch (e) { keyLeak = (e as Error).message; }
eq("a refusal says why, without the key", [keyLeak.includes("bad key"), keyLeak.includes("wrong-key-value")], [true, false]);
let badUrl = false;
try { new ReadOnlyConvex({ url: "ftp://x", adminKey: KEY }); } catch (e) { badUrl = e instanceof LiveReadError; }
eq("only an http(s) address is accepted", badUrl, true);

console.log("\nthe check reports without storing anything");
const embed = async (texts: string[]) => texts.map((t) => {
  if (t === "Empty resume profile placeholder") return Float32Array.from(PLACEHOLDER);
  const n = Number(t.match(/number (\d+)/)?.[1] ?? -1);
  // two CVs "embedded by another model": their fresh vector differs
  return Float32Array.from(n === 1 || n === 2 ? vec(n + 500) : vec(n));
});
const report = await checkLive(client(), { pageSize: 25, maxPages: 10, embed, sameModelSample: 20 });
eq("every CV read, across pages", [report.resumesRead, report.pages, report.complete], [60, 3, true]);
eq("where the text is", report.text, { inDatabase: 54, onlyInR2: 6, none: 0 });
eq("vector widths", report.vectorWidths, { "1024": 58, "1536": 2 });
eq("CVs sharing one identical vector are found", [report.cvsInIdenticalGroups, report.identicalVectorGroups[0]?.size], [3, 3]);
eq("and recognised as the placeholder", report.placeholder, { checked: true, matches: 3 });
eq("vectors from another model are spotted", [report.sameModel.checked, report.sameModel.disagree], [20, 2]);
eq("candidate records are readable", report.sampleCandidates.withTitle > 0 && report.sampleCandidates.withSkills > 0, true);
eq("and nothing was stored", fs.existsSync(path.join(tmp, ".data", "db.json")) ? repo.liveMirrorCount() : 0, 0);

console.log("\nmapping their records to ours");
const mapped = mapCandidate(candidateDoc("c9") as any, resumes[9] as any);
eq("title, employer, years", [mapped.currentTitle, mapped.currentEmployer, mapped.totalExperienceYears], ["Senior Accountant", "Acme", 8]);
eq("skills, including object-shaped ones", mapped.skills, ["IFRS", "Audit"]);
eq("education and certificates", [mapped.educationDegree, mapped.qualifications], ["BSc Accounting", "ACCA"]);
eq("expected salary with currency", mapped.expectedSalary, "LKR 350,000");
eq("job history with years", mapped.workHistory, [{ title: "Auditor", employer: "Acme", fromYear: 2018, toYear: null }]);
eq("years from dates", [yearOf("03/2019"), yearOf("Present"), yearOf("sometime")], [2019, null, null]);

console.log("\nsync copies into this build, using their vectors as they are");
repo.reset();
calls.length = 0;
const synced = await syncLive(client(), { pageSize: 25, useLiveVectors: true });
eq("all CVs copied", [synced.read, synced.added, synced.updated], [60, 60, 0]);
eq("1,024-wide vectors copied, others skipped", [synced.vectors, synced.skippedVectors], [58, 2]);
eq("still only reads", calls.every((c) => c.url === "/api/query" && c.method === "POST" && Object.values(READ_FUNCTIONS).includes(c.path as any)), true);
eq("the CV text is kept for this build", repo.cvTextFor("lv_c9")?.startsWith("Senior accountant"), true);
eq("a vector is there under the copied id", candidateVector("lv_c10")?.length, 1024);
const noReembed = await ensureVectors("candidates", resumes.slice(0, 50).filter((_, i) => i !== 3 && i !== 4).map((r) => ({ id: `lv_${r.candidateId}`, text: "our own different text" })));
eq("copied vectors are never paid for again", noReembed.ok && noReembed.embedded, 0);
const again = await syncLive(client(), { pageSize: 25, useLiveVectors: true });
eq("a second sync refreshes, doesn't duplicate", [again.added, again.updated, repo.liveMirrorCount()], [0, 60, 60]);

console.log("\nby default it embeds here instead of trusting the live vectors");
let embedCalls = 0;
const realFetch = globalThis.fetch;
process.env.OPENROUTER_API_KEY = "test-key";
globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).includes("openrouter.ai/api/v1/embeddings")) {
    embedCalls++;
    const n = JSON.parse(init.body).input.length;
    // 1,024, because the request asks for `dimensions: 1024` and a provider
    // that honours it returns exactly that. It used to return 1,536 here and
    // the code cut it down — which produced a vector in a different space from
    // the index, since `dimensions` re-normalises and a slice does not.
    return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec(i + 1, 1024) })), usage: { total_tokens: n * 1000 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;
repo.reset();
const own = await syncLive(client(), { pageSize: 25 });
eq("every CV embedded here, in the live width", [own.vectors, candidateVector("lv_c10")?.length], [60, 1024]);
eq("with the model's calls counted", [embedCalls > 0, own.embedTokens], [true, 60000]);
globalThis.fetch = realFetch;
delete process.env.OPENROUTER_API_KEY;

console.log("\nQdrant, read calls only");
const qcalls: { method: string; url: string; key: string }[] = [];
const qserver = http.createServer((req, res) => {
  qcalls.push({ method: req.method!, url: req.url!, key: String(req.headers["api-key"] ?? "") });
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: req.url!.endsWith("/count") ? { count: 60 } : req.url!.endsWith("/search") ? [] : { points_count: 60, config: { params: { vectors: { size: 1024, distance: "Cosine" } } } } }));
});
await new Promise<void>((r) => qserver.listen(0, "127.0.0.1", () => r()));
const q = new ReadOnlyQdrant({ url: `http://127.0.0.1:${(qserver.address() as { port: number }).port}`, apiKey: "read-only-key" });
eq("collection info", (await q.info()).config?.params?.vectors?.size, 1024);
await q.count(); await q.search(vec(1), 5);
eq("only info, count and search were called", qcalls.map((c) => `${c.method} ${c.url}`), ["GET /collections/candidate_vectors", "POST /collections/candidate_vectors/points/count", "POST /collections/candidate_vectors/points/search"]);
eq("with the read-only key", qcalls.every((c) => c.key === "read-only-key"), true);
eq("there is no way to write a point", [typeof (q as any).upsert, typeof (q as any).delete], ["undefined", "undefined"]);

server.close(); qserver.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
