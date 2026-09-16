/**
 * C141_DATA_DIR=.data-live-test node --import ./tests/alias.mjs scripts/live-test/headhunt.ts --step suggestions|benchmark|jd
 *
 * Step 3 of the live-data test (13 September), all under the $5 hard stop:
 *
 *   suggestions — one sourcing round for every test job
 *   benchmark   — the old way (top model browsing) against the rebuilt way
 *                 (searches + one cheap sort) on the jobs named by --jobs
 *   jd          — JD drafted by Opus and by Sonnet from the same brief, beside
 *                 the JD the team actually wrote, on the jobs named by --jobs
 *
 * Results are written to the test folder for judging; nothing is sent anywhere.
 */
import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch { /* shell env */ }
if (!(process.env.C141_DATA_DIR ?? "").trim()) { console.error("Set C141_DATA_DIR to the test folder."); process.exit(1); }
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const step = arg("step", "");
const jobNums = arg("jobs", "1,3,9").split(",").map(Number);

const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { runSourcing, benchmarkViaSearch } = await import("@/lib/sourcing");
const { generateBenchmark, parseBenchmark, generateJdText } = await import("@/lib/headhunt");
const { spentSoFar } = await import("@/lib/spend");
const { canonicalProfile } = await import("@/lib/serper");

const out = path.join(dataDir(), "judging");
fs.mkdirSync(out, { recursive: true });
const liveJobs = JSON.parse(fs.readFileSync(path.join(dataDir(), "live-jobs.json"), "utf8")) as any[];
const openings = repo.openings();

const specFor = (o: (typeof openings)[number]) => {
  const client = repo.client(o.clientId);
  return {
    title: o.title,
    clientName: client?.name ?? "the client",
    clientCompanyNames: [client?.name ?? ""].filter(Boolean),
    jdText: o.jdMarkdown || o.title,
    locations: o.locations,
    targetNationalities: o.targetNationalities,
    targetGender: o.targetGender,
    salaryNote: o.packageNotes,
    targetEmployers: [] as string[],
    alreadyKnown: repo.suggestions(o.id).map((s) => canonicalProfile(s.linkedinUrl ?? "")).filter((x): x is string => Boolean(x)),
  };
};

if (step === "suggestions") {
  const rows = [];
  for (const [n, o] of openings.entries()) {
    if (repo.suggestions(o.id).length) { console.log(`job ${n + 1}: already has a round, skipped`); continue; }
    const t = Date.now();
    const run = await runSourcing(specFor(o), 1);
    if (!run.error) repo.addSuggestions(o.id, run.suggestions.map((s) => ({ ...s, openingId: o.id, generatedFor: o.assignedTaIds[0] ?? null, keptBy: null })));
    const row = { job: n + 1, title: o.title, found: run.suggestions.length, scanned: run.scanned, rejected: run.rejected ?? 0, queries: run.queries.length, credits: run.credits, cost: Number(run.cost.toFixed(4)), seconds: Math.round((Date.now() - t) / 1000), note: run.note ?? null, error: run.error ?? null };
    rows.push({ ...row, plan: run.plan, suggestions: run.suggestions.map((s) => ({ tier: s.tier, name: s.name, headline: s.headline, why: s.why, concern: s.concern, url: s.linkedinUrl })) });
    console.log(JSON.stringify(row), `· $${spentSoFar().toFixed(4)} spent`);
    fs.writeFileSync(path.join(out, "suggestions.json"), JSON.stringify(rows, null, 1));
    if (run.error === "spend_cap") break;
  }
}

if (step === "benchmark") {
  const rows = [];
  for (const n of jobNums) {
    const o = openings[n - 1];
    const client = repo.client(o.clientId);
    const spec = specFor(o);
    const t1 = Date.now();
    const oldRes = await generateBenchmark({ title: o.title, clientName: client?.name ?? "the client", industry: client?.industry ?? "", locations: o.locations, packageNotes: o.packageNotes, mustHaves: [] });
    const oldRows = oldRes.ok ? parseBenchmark(oldRes.text, o.id, oldRes.sources) : [];
    const oldSecs = Math.round((Date.now() - t1) / 1000);
    const spentAfterOld = spentSoFar();
    const t2 = Date.now();
    const newRun = await benchmarkViaSearch(spec, o.id);
    const row = {
      job: n, title: o.title, client: client?.name,
      old: { ok: oldRes.ok, error: oldRes.ok ? null : oldRes.reason, seconds: oldSecs, rows: oldRows.map((r) => ({ kind: r.kind, name: r.name, title: r.title, company: r.company, url: r.linkedinUrl, confidence: r.confidence, source: r.sourceUrl })) },
      new: { error: newRun.error ?? null, note: newRun.note ?? null, seconds: Math.round((Date.now() - t2) / 1000), queries: newRun.queries.length, credits: newRun.credits, cost: Number(newRun.cost.toFixed(4)), rows: newRun.rows.map((r) => ({ kind: r.kind, name: r.name, title: r.title, company: r.company, url: r.linkedinUrl, confidence: r.confidence })) },
      spentOld: spentAfterOld,
    };
    rows.push(row);
    console.log(`job ${n}: old ${row.old.rows.length} rows (${oldSecs}s, ${row.old.error ?? "ok"}) · new ${row.new.rows.length} rows (${row.new.seconds}s, $${row.new.cost}) · $${spentSoFar().toFixed(4)} spent`);
    fs.writeFileSync(path.join(out, "benchmark.json"), JSON.stringify(rows, null, 1));
  }
}

if (step === "jd") {
  const rows = [];
  for (const n of jobNums) {
    const o = openings[n - 1];
    const live = liveJobs[n - 1];
    const client = repo.client(o.clientId);
    // What a TA would bring back from the client call: the facts, not the prose.
    const notes = [
      `Role: ${o.title}`, `Client industry: ${client?.industry ?? ""}`, `Location: ${o.locations.join(", ")}`,
      live.expMin ? `Experience: at least ${live.expMin} years` : "", live.seniority ? `Level: ${String(live.seniority).replace(/_/g, " ")}` : "",
      live.edu ? `Education: ${live.edu}` : "",
      (live.skills ?? []).length ? `Must have: ${(live.skills as string[]).join("; ")}` : "",
      (live.nice ?? []).length ? `Nice to have: ${(live.nice as string[]).join("; ")}` : "",
    ].filter(Boolean).join("\n");
    const ctx = { title: o.title, clientName: "Our client", industry: client?.industry ?? "", locations: o.locations, packageNotes: "", mustHaves: live.skills ?? [] };
    const drafts: Record<string, { text: string; error: string | null; seconds: number }> = {};
    for (const model of ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]) {
      process.env.C141_MODEL_JD = model;
      const t = Date.now();
      const r = await generateJdText(ctx, [{ author: "the live system", role: "lead", notes }], "");
      drafts[model] = { text: r.ok ? r.text : "", error: r.ok ? null : r.reason, seconds: Math.round((Date.now() - t) / 1000) };
    }
    delete process.env.C141_MODEL_JD;
    rows.push({ job: n, title: o.title, notes, teamJd: live.jd, drafts });
    console.log(`job ${n}: ${Object.entries(drafts).map(([m, d]) => `${m.split("/")[1]} ${d.error ?? `${d.text.length} chars`} ${d.seconds}s`).join(" · ")} · $${spentSoFar().toFixed(4)} spent`);
    fs.writeFileSync(path.join(out, "jd.json"), JSON.stringify(rows, null, 1));
  }
}

if (!["suggestions", "benchmark", "jd"].includes(step)) console.log("--step suggestions | benchmark | jd");
