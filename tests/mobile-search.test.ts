/**
 * `GET /api/mobile/v1/search?q=` (src/lib/mobile/search.ts): the web's /search
 * page as data — same permission, same rows, names and titles only. Run
 * against a disposable copy of the seed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-search-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { can } = await import("@/lib/auth");
const { mobileSearch, searchRefusal } = await import("@/lib/mobile/search");
repo.reset();

const synthetic = (role: Role, isActive = true): User => ({
  id: `u_test_${role}`,
  name: `Test ${role}`,
  email: `${role}@example.test`,
  phone: null,
  routingEmail: null,
  role,
  initials: "TT",
  isActive,
});

function keysOf(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, keys));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      keysOf(v, keys);
    }
  }
  return keys;
}

/** A searchable fragment of a seeded candidate's name. */
function someCandidateName(): string {
  const c = repo.candidates().find((x) => !x.cvFileMissing && x.fullName.length >= 4);
  assert(c, "the seed has a candidate");
  return c.fullName.split(/\s+/)[0];
}

test("a client is refused, with the web's own message", () => {
  const client = synthetic("client");
  const decision = can(client, "database.read");
  assert(!decision.ok);
  assert.equal(searchRefusal(client), decision.message);
  assert.equal(searchRefusal(client), "The database search covers every client's work, not only yours.");
  assert.equal(searchRefusal(synthetic("ta", false)), "This account is deactivated.");
  for (const role of ["admin", "ta_lead", "director", "ta", "ta_support", "ops", "viewer"] as Role[]) {
    assert.equal(searchRefusal(synthetic(role)), null, `${role} may search`);
  }
});

test("a query under two characters searches nothing", () => {
  for (const q of ["", " ", "a", "  b  "]) {
    assert.deepEqual(mobileSearch(q), { apiVersion: 1, q, openings: [], openingTotal: 0, candidates: [], candidateTotal: 0 });
  }
});

test("the rows are the page's rows, and the totals count them all", () => {
  const q = someCandidateName();
  const found = repo.search(q);
  const payload = mobileSearch(q);
  assert.equal(payload.q, q);
  assert(payload.candidateTotal > 0, "the candidate's own name finds them");
  assert.equal(payload.candidateTotal, found.candidates.length);
  assert.equal(payload.openingTotal, found.openings.length);
  assert.deepEqual(payload.candidates.map((c) => c.candidateId), found.candidates.map((f) => f.candidate.id));

  for (const row of payload.candidates) {
    const hit = found.candidates.find((f) => f.candidate.id === row.candidateId)!;
    assert.equal(row.name, hit.candidate.fullName);
    if (hit.application) {
      const opening = repo.opening(hit.application.openingId);
      assert.deepEqual(row.application, {
        applicationId: hit.application.id,
        openingId: hit.application.openingId,
        openingTitle: opening?.title ?? "",
        clientName: opening ? repo.client(opening.clientId)?.name ?? "" : "",
      });
    } else assert.equal(row.application, null);
  }

  const opening = repo.openings()[0];
  const byTitle = mobileSearch(opening.title);
  assert(byTitle.openings.some((o) => o.id === opening.id && o.status === opening.status));
  assert.equal(byTitle.openings.find((o) => o.id === opening.id)!.clientName, repo.client(opening.clientId)?.name ?? "");
});

test("the lists are capped and the totals are not", () => {
  // "e" alone is too short; two common letters find many of both.
  const q = "an";
  const full = mobileSearch(q);
  assert(full.candidateTotal >= 2 && full.openingTotal >= 1, "the seed matches 'an' more than once");
  const capped = mobileSearch(q, [], 1);
  assert.equal(capped.candidates.length, 1);
  assert(capped.openings.length <= 1);
  assert.equal(capped.candidateTotal, full.candidateTotal);
  assert.equal(capped.openingTotal, full.openingTotal);
  assert.deepEqual(capped.candidates[0], full.candidates[0]);
  assert(full.candidates.length <= 100 && full.openings.length <= 100);
});

test("ranked ids from the database search come first", () => {
  const q = "an";
  const plain = mobileSearch(q);
  const last = plain.candidates.at(-1)!;
  const ranked = mobileSearch(q, [last.candidateId]);
  assert.equal(ranked.candidates[0].candidateId, last.candidateId);
});

test("no email, phone or CV leaves the server", () => {
  for (const q of [someCandidateName(), "an", "er"]) {
    const payload = mobileSearch(q);
    const keys = keysOf(payload);
    for (const k of ["email", "phone", "cv", "cvUrl", "cvText", "cvFileId", "notes", "salary", "nic", "linkedinUrl"]) {
      assert(!keys.has(k), `no "${k}" field`);
    }
    const json = JSON.stringify(payload);
    for (const c of repo.candidates()) {
      if (c.email) assert(!json.includes(c.email), "no candidate email appears");
      if (c.phone) assert(!json.includes(c.phone), "no candidate phone number appears");
    }
  }
});
