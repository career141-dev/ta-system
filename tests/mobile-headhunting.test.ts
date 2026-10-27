/** The phone headhunting overview mirrors the website and stays opening-scoped. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-headhunting-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileHeadhunting } = await import("@/lib/mobile/headhunting");
repo.reset();

test("an assigned recruiter receives the website's sourcing totals and actions", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta)[0]!;
  const vault = repo.linkVault(opening.id);
  const payload = mobileHeadhunting(ta, opening.id);
  assert(payload);
  assert.equal(payload.stats.links, vault.length);
  assert.equal(payload.stats.approached, vault.filter((row) => row.outcome !== "no_contact").length);
  assert.equal(payload.stats.reachedCv, vault.filter((row) => ["cv_received", "shortlisted"].includes(row.outcome)).length);
  assert.equal(payload.next.at(-1)?.key, "benchmark");
  assert(payload.next.every((step) => step.href.startsWith(`/openings/${opening.id}/hh/`)));
});

test("eye-mark yield uses the website's rounded conversion rates", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta)[0]!;
  const vault = repo.linkVault(opening.id);
  const eye = vault.filter((row) => row.isEyeMarked);
  const eyeReached = eye.filter((row) => ["cv_received", "shortlisted"].includes(row.outcome));
  const payload = mobileHeadhunting(ta, opening.id)!;
  assert.equal(payload.eyeMarkYield.eyeMarked, eye.length);
  assert.equal(payload.eyeMarkYield.eyeMarkedReachedCv, eyeReached.length);
  assert.equal(payload.eyeMarkYield.eyeMarkedRate, eye.length ? Math.round((eyeReached.length / eye.length) * 100) : null);
});

test("a client seat cannot read the sourcing overview", () => {
  const client = { id: "u_hh_client", name: "Client", email: "client@example.test", phone: null, routingEmail: null, role: "client" as const, initials: "CL", isActive: true };
  assert.equal(mobileHeadhunting(client, repo.openings()[0]!.id), null);
});
