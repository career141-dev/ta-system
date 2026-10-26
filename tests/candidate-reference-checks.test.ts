/** Referee checks share one permission gate and one search result parser. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-candidate-reference-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { checkCandidateReferee } = await import("@/lib/candidates/referenceChecks");
repo.reset();

const admin: User = {
  id: "u_reference_admin", name: "Reference Admin", email: "reference-admin@example.test", phone: null,
  routingEmail: null, role: "admin", initials: "RA", isActive: true,
};
const convexQuery = async <T,>() => undefined as T;

function referencedApplication() {
  const referee = repo.referees()[0]!;
  const app = repo.applications().find((row) => row.candidateId === referee.fromCandidateId)!;
  assert(referee && app, "the seed has a candidate referee");
  return { referee, app };
}

test("a referee cannot be checked through another candidate", async () => {
  const { referee, app } = referencedApplication();
  const other = repo.applications(app.openingId).find((row) => row.candidateId !== app.candidateId)!;
  assert(other);
  let searched = false;
  const result = await checkCandidateReferee(admin, app.openingId, referee.id, other.id, {
    convexQuery,
    searchConfigured: () => true,
    search: async () => { searched = true; return { hits: [], credits: 0 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(searched, false);
});

test("the shared check reports the public role and canonical profile", async () => {
  const { referee, app } = referencedApplication();
  const result = await checkCandidateReferee(admin, app.openingId, referee.id, app.id, {
    convexQuery,
    searchConfigured: () => true,
    search: async () => ({
      credits: 1,
      hits: [{
        url: "https://www.linkedin.com/in/reference-person/?trk=search",
        title: `${referee.name} - Finance Director at ${referee.company ?? "Career141"} | LinkedIn`,
        snippet: `Finance Director at ${referee.company ?? "Career141"}`,
      }],
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.message, /^LinkedIn today:/);
  assert.equal(result.profileUrl, "https://www.linkedin.com/in/reference-person");
});
