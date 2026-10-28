/** The phone Research payload mirrors the website's report and stays opening-scoped. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-research-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { mobileResearch } = await import("@/lib/mobile/research");
repo.reset();

test("an assigned recruiter receives all eight Research fields and benchmark choices", () => {
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta)[0]!;
  repo.saveResearch({
    openingId: opening.id, clientId: opening.clientId,
    fields: {
      similarDesignation: "Finance Lead", websiteLink: "https://example.test", servicesProvider: ["Manufacturing"],
      country: "Sri Lanka", location: "Colombo", competitors: ["Example Rival"], socialMedia: "https://linkedin.com/company/example",
      companyOverview: "A sourced overview.", competitorProfiles: [{ name: "Example Rival", website: "https://rival.example", linkedin: "", whatTheyDo: "Manufacturing", location: "Colombo", summary: "A competitor.", sources: [{ title: "About", url: "https://rival.example/about", quote: "About" }] }],
    },
    editedFields: ["location"], markdown: "", sources: [{ title: "About", url: "https://example.test/about", quote: "About" }],
    searches: 4, model: "Test search", generatedBy: ta.id, generatedAt: Date.now(),
  });
  repo.replaceBenchmarks(opening.id, [{ openingId: opening.id, name: "Sample Person", title: opening.title, company: "Example Rival", linkedinUrl: null, kind: "competitor", confidence: "high", note: "Sourced", sourceUrl: "https://rival.example/team", sourceTitle: "Team", isSelected: true, generatedAt: Date.now() }]);
  const payload = mobileResearch(ta, opening.id);
  assert(payload);
  assert.equal(Object.keys(payload.fields).length, 8);
  assert.deepEqual(payload.editedFields, ["location"]);
  assert.equal(payload.competitors[0]?.sources[0]?.url, "https://rival.example/about");
  assert.equal(payload.benchmark.picked, 1);
  assert.equal(payload.benchmark.entries[0]?.isSelected, true);
});

test("a report-free opening returns explicit empty state data", () => {
  repo.reset();
  const ta = repo.users().find((user) => user.role === "ta" && user.isActive)!;
  const opening = repo.openingsForUser(ta).find((row) => !repo.research(row.id))!;
  const payload = mobileResearch(ta, opening.id)!;
  assert.equal(payload.run.hasReport, false);
  assert.equal(payload.fields.websiteLink, "");
  assert.deepEqual(payload.sources, []);
});

test("a client seat cannot read Research", () => {
  const client = { id: "u_research_client", name: "Client", email: "client@example.test", phone: null, routingEmail: null, role: "client" as const, initials: "CL", isActive: true };
  assert.equal(mobileResearch(client, repo.openings()[0]!.id), null);
});
