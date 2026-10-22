/** The native pipeline payload and the shared web/phone CV upload service. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-pipeline-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobilePipeline, MOBILE_PIPELINE_STAGES } = await import("@/lib/mobile/pipeline");
const { mayUploadHeadHuntCv, queueHeadHuntCv } = await import("@/lib/openings/hhUpload");
const { seatFor, visibleToSeat } = await import("@/lib/visibility");
repo.reset();

const seeded = (role: Role) => {
  const found = repo.users().find((user) => user.role === role && user.isActive);
  assert(found, `the seed has a ${role}`);
  return found;
};
const synthetic = (role: Role): User => ({
  id: `u_pipeline_${role}`,
  name: `Pipeline ${role}`,
  email: `${role}@example.test`,
  phone: null,
  routingEmail: null,
  role,
  initials: "PP",
  isActive: true,
});

test("the payload is the web stage page's seat-scoped list", () => {
  const ta = seeded("ta");
  const opening = repo.openingsForUser(ta).find((row) => repo.applications(row.id).length > 0)!;
  assert(opening);
  const assignment = repo.assignmentFor(opening.id, ta.id)!;
  const seat = seatFor(ta, assignment.role);
  const visible = visibleToSeat(repo.applications(opening.id), seat);
  const stage = MOBILE_PIPELINE_STAGES.find((item) => visible.some((app) => app.stage === item)) ?? "ta_follow_up";
  const payload = mobilePipeline(ta, opening.id, stage)!;
  assert(payload);
  assert.equal(payload.stats.atStage, visible.filter((app) => app.stage === stage).length);
  assert.equal(payload.candidates.length, payload.stats.atStage);
  assert(payload.stages.every((item) => MOBILE_PIPELINE_STAGES.includes(item.stage)));
  assert(payload.candidates.every((candidate) => candidate.waitingDays >= 0));
});

test("a client seat gets only the client-visible stages and no actions", () => {
  const opening = repo.openings()[0];
  const client = synthetic("client");
  const payload = mobilePipeline(client, opening.id, "client_shortlist")!;
  assert(payload);
  assert.deepEqual(payload.stages.map((item) => item.stage), ["client_shortlist", "interview", "offer", "placed"]);
  assert(payload.candidates.every((candidate) => !candidate.canCall && !candidate.canEmail && candidate.allowedStages.length === 0));
  assert.equal(mobilePipeline(client, opening.id, "rejected"), null);
});

test("candidate contact values never leave the server", () => {
  const admin = synthetic("admin");
  const opening = repo.openings()[0];
  const payloads = MOBILE_PIPELINE_STAGES.map((stage) => mobilePipeline(admin, opening.id, stage));
  const json = JSON.stringify(payloads);
  for (const candidate of repo.candidates()) {
    if (candidate.email) assert(!json.includes(candidate.email), "no candidate email");
    if (candidate.phone) assert(!json.includes(candidate.phone), "no candidate phone");
  }
});

test("work-location jobs default exactly as the web view does", () => {
  const admin = synthetic("admin");
  const opening = repo.openings().find((row) => row.workLocations?.some((location) => !location.archived));
  if (!opening) return;
  const active = opening.workLocations!.filter((location) => !location.archived);
  const payload = mobilePipeline(admin, opening.id, "ta_follow_up")!;
  assert.deepEqual(payload.opening.workLocations, active.map(({ id, name }) => ({ id, name })));
  assert.equal(payload.activeWorkLocationId, active.length === 1 ? active[0].id : "");
  assert.equal(payload.followUp?.canUploadCv, active.length === 1);
});

test("the shared upload refuses invalid files before storage", async () => {
  const opening = repo.openings()[0];
  const admin = synthetic("admin");
  assert.deepEqual(mayUploadHeadHuntCv(admin, opening.id), { ok: true });
  assert.equal(mayUploadHeadHuntCv(synthetic("viewer"), opening.id).ok, false);
  const deps = {
    convexMutation: async <T,>() => undefined as T,
    internalUploadUrl: (value: string) => value,
    put: async () => ({ ok: true, status: 200, json: async () => ({ storageId: "x" }) }),
  };
  const file = (name: string, size: number, type: string) => ({ name, size, type, arrayBuffer: async () => new ArrayBuffer(0) });
  const empty = await queueHeadHuntCv(admin, opening.id, undefined, file("cv.pdf", 0, "application/pdf"), deps);
  assert.equal(empty.ok, false);
  assert.equal(!empty.ok && empty.status, 400);
  const wrong = await queueHeadHuntCv(admin, opening.id, undefined, file("cv.exe", 12, "application/octet-stream"), deps);
  assert.equal(wrong.ok, false);
  assert.match(!wrong.ok ? wrong.message : "", /not a PDF or a Word document/);
});

