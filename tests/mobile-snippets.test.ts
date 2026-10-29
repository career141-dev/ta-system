/** The phone snippet is derived from the same approved JD as the website. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-snippets-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileSnippet } = await import("@/lib/mobile/snippets");
const { snippetFromOpening } = await import("@/lib/snippet");
repo.reset();

test("an assigned recruiter receives the website's approved-JD snippet", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta).find((row) => row.jdStatus === "approved")!;
  assert(opening);
  const client = repo.client(opening.clientId)!;
  const payload = mobileSnippet(ta, opening.id);
  assert(payload?.fields);
  assert.deepEqual(payload.fields, snippetFromOpening({
    title: opening.title, clientIndustry: client.industry, locations: opening.locations,
    salaryMin: opening.salaryMin, salaryMax: opening.salaryMax, currency: opening.salaryCurrency,
    packageNotes: opening.packageNotes, jdMarkdown: opening.jdMarkdown, taEmail: ta.email, taPhone: ta.phone,
  }));
  assert.equal(payload.levels.length, 5);
});

test("a draft JD explains why there is no editable card", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta)[0]!;
  repo.updateOpening(opening.id, { jdStatus: "draft" });
  const payload = mobileSnippet(ta, opening.id);
  assert(payload);
  assert.equal(payload.approved, false);
  assert.equal(payload.fields, null);
});

test("a client seat cannot read the desk's snippet studio", () => {
  const client = { id: "u_mobile_client", name: "Client", email: "client@example.test", phone: null, routingEmail: null, role: "client" as const, initials: "CL", isActive: true };
  const opening = repo.openings()[0]!;
  assert.equal(mobileSnippet(client, opening.id), null);
});
