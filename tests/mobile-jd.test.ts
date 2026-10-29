/** The native JD screen shares the website's access and write rules. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-jd-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileJd } = await import("@/lib/mobile/jd");
const { amendJdText, approveJdText, writeJdNotes } = await import("@/lib/openings/jdWrites");
repo.reset();

const user = (role: Role): User => ({
  id: `u_jd_${role}`, name: `JD ${role}`, email: `jd-${role}@example.test`, phone: null,
  routingEmail: null, role, initials: "JD", isActive: true,
});
const deps = { convexQuery: async <T,>() => undefined as T, markTablesStale: () => undefined, resetStore: () => undefined };

test("an authorised reader receives notes, document and requirements without actions markup", () => {
  const opening = repo.openings()[0]!;
  const payload = mobileJd(user("admin"), opening.id);
  assert(payload);
  assert.equal(payload.context.openingId, opening.id);
  assert.equal(typeof payload.document.markdown, "string");
  assert.equal(payload.access.canWrite, true);
  assert(payload.notes.others.every((row) => typeof row.body === "string"));
});

test("notes, approval and amendments use one shared writer", async () => {
  const admin = user("admin");
  const opening = repo.openings()[0]!;
  const notes = await writeJdNotes(admin, opening.id, "Colombo. CA qualified. FMCG experience.", deps);
  assert.deepEqual(notes, { ok: true, message: "Notes saved." });
  assert.equal(repo.briefsForOpening(opening.id).some((row) => row.capturedBy === admin.id && row.notesMarkdown.includes("FMCG")), true);

  const approved = await approveJdText(admin, opening.id, "## Finance Manager\n\n- CA qualified", deps);
  assert.equal(approved.ok, true);
  assert.equal(repo.opening(opening.id)?.jdStatus, "approved");

  const amended = await amendJdText(admin, opening.id, "## Finance Manager\n\n- CA or CIMA qualified", deps);
  assert.equal(amended.ok, true);
  assert.match(repo.opening(opening.id)?.jdMarkdown ?? "", /CIMA/);
});

test("a client contact can read the approved JD but cannot change it", async () => {
  const client = user("client");
  const opening = repo.openings().find((row) => repo.applications(row.id).some((app) => ["client_shortlist", "interview", "offer", "placed"].includes(app.stage)))!;
  const team = repo.assignments(opening.id).map(({ userId, role }) => ({ userId, role }));
  repo.setAssignments(opening.id, [...team, { userId: client.id, role: "client_contact" }], user("admin").id);
  const payload = mobileJd(client, opening.id);
  assert(payload);
  assert.equal(payload.access.canWrite, false);
  const result = await amendJdText(client, opening.id, "## Changed", deps);
  assert.equal(result.ok, false);
});
