import assert from "node:assert/strict";
import test from "node:test";
import { getFunctionName } from "convex/server";
import { runCvExtraction } from "../convex/cvs/cvExtraction";
import { hasCvDetails, hasCvDetailsJson } from "../convex/lib/jsonAnswer";
import { readFileSync } from "node:fs";

test("filing an unread replacement changes only the file on a held application", async () => {
  // Load this mutation's actual handler without importing the unrelated voice/
  // follow-up module graph (which relies on Convex's runtime type stripping).
  const source = readFileSync("convex/applications/applications.ts", "utf8");
  const { stripTypeScriptTypes } = await import("node:module");
  const start = source.indexOf("export const createApplication = ");
  const end = source.indexOf("\nexport ", start + 1);
  const body = stripTypeScriptTypes(source.slice(start, end).replace("export const createApplication =", "const createApplication ="));
  const validator: any = new Proxy(() => validator, { get: () => validator });
  const createApplication = new Function("internalMutation", "v", `${body}; return createApplication;`)((value: any) => value, validator);
  const patches: unknown[] = [];
  const chain: any = {
    withIndex: () => chain, filter: () => chain,
    first: async () => ({ _id: "application", currentStage: "new_cvs", isActive: false, cvFileId: "old" }),
  };
  const ctx: any = {
    db: {
      get: async () => ({ _id: "person", fullName: "Verified Name" }),
      query: () => chain,
      patch: async (...args: unknown[]) => { patches.push(args); },
    },
    scheduler: { runAfter: async () => { throw new Error("Must not score"); } },
    runMutation: async () => { throw new Error("Must not advance follow-up"); },
  };
  const result = await createApplication.handler(ctx, {
    candidateId: "person", jobId: "job", cvFileId: "new", sourceChannel: "manual_upload", skipScoring: true,
  });
  assert.equal(result, "application");
  assert.deepEqual(patches, [["application", { cvFileId: "new" }]]);
});

test("empty model answers never qualify as a read CV", () => {
  for (const value of [{}, [], null, { fullName: "  ", skills: [], jobHistory: [] }, { skills: [{}], jobHistory: [null] }]) {
    assert.equal(hasCvDetails(value), false);
    assert.equal(hasCvDetailsJson(JSON.stringify(value)), false);
  }
  assert.equal(hasCvDetailsJson('```json\n{"fullName":"Example Applicant"}\n```'), true);
  assert.equal(hasCvDetails({ skills: [{ value: "Accounting" }] }), true);
  assert.equal(hasCvDetails({ jobHistory: [{ title: "Engineer" }] }), true);
});

for (const scenario of ["download", "short text", "replacement", "held person"] as const) {
  test(`${scenario}: preserve the applicant and filing without scoring`, async () => {
    const calls: { name: string; args: any }[] = [];
    const existing = scenario === "replacement" || scenario === "held person";
    const upload = {
      _id: "upload", status: "uploaded", fileName: "Example Applicant.txt",
      storageId: "file", assignToJob: "job", assignToJobPost: "post",
      alsoAssignTo: [{ jobId: "other-job", jobPostId: "other-post" }],
      ...(existing ? { candidateId: "person" } : {}),
      replaceKeepDetails: scenario === "replacement",
    };
    const ctx: any = {
      storage: { getUrl: async () => scenario === "download" ? null : "https://example.invalid/test" },
      runQuery: async (ref: any) => {
        const name = getFunctionName(ref);
        if (name.endsWith(":getCvUpload")) return upload;
        if (name.endsWith(":findCandidateByHash")) return null;
        if (name.endsWith(":getCandidateForParsing")) return { _id: "person", isParsed: !existing ? false : true, fullName: existing ? "Verified Name" : undefined };
        throw new Error(`Unexpected query ${name}`);
      },
      runMutation: async (ref: any, args: any) => {
        const name = getFunctionName(ref);
        calls.push({ name, args });
        if (name.endsWith(":lockExtraction")) return true;
        if (name.endsWith(":createCandidate")) return "person";
        return null;
      },
      scheduler: { runAfter: async () => { throw new Error("Unread CV must not schedule scoring or embedding"); } },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Too short");
    try {
      await runCvExtraction(ctx, { cvUploadId: "upload", fileType: "txt", sourceChannel: "manual_upload", batchId: "batch", logId: "log" } as any);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.some((c) => c.name.includes("deleteCandidate")), false);
    const finished = calls.find((c) => c.name.endsWith(":updateCvUpload") && c.args.status === "needs_review");
    assert.equal(finished?.args.candidateId, "person");
    assert.equal(finished?.args.processingStage, "needs_review");
    assert.match(finished?.args.errorMessage, /kept for review/);
    const filings = calls.filter((c) => c.name.endsWith(":createApplication"));
    assert.equal(filings.length, 2);
    assert.ok(filings.every((c) => c.args.skipScoring === true));
    assert.ok(calls.some((c) => c.name.endsWith(":updateBatchProgress") && c.args.status === "failed"));
    assert.ok(calls.some((c) => c.name.endsWith(":checkAndTriggerNextBatch")));
    assert.ok(calls.some((c) => c.name.endsWith(":unlockExtraction")));
    if (existing) assert.equal(calls.some((c) => c.name.endsWith(":updateCandidateFields")), false);
  });
}
