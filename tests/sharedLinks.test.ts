/**
 * Two TAs on one opening may both hold the same LinkedIn person (22 Oct).
 * The paste no longer refuses the second TA; whoever shortlists first works
 * them, and the other TA's row says so instead of showing their progress.
 * Uses the same store calls the actions make, on a disposable seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-shared-links-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { isDeskWide } = await import("@/lib/auth");
const { linkKey } = await import("@/lib/url");
const { otherHolders, rowApplication, rowCountsFor } = await import("@/lib/sharedLinks");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const [thushini, priya, third] = repo.users().filter((u) => u.role === "ta");
const lead = repo.users().find((u) => isDeskWide(u) && u.role === "ta_lead")!;
const deskWide = (id: string) => { const u = repo.user(id); return !!u && isDeskWide(u); };
const o = repo.openings()[0];
const url = "https://www.linkedin.com/in/sanjeev-shared-test";
const key = linkKey(url)!;

console.log("\nThe second TA's paste is not refused by the first TA's row");
const first = repo.addLink(o.id, url, thushini.id, "Sanjeev Shared");
eq("Thushini's own row counts for her", repo.findLinkByUrl(o.id, key, rowCountsFor(thushini, deskWide))?.id, first);
eq("Thushini's row does not count for Priya", repo.findLinkByUrl(o.id, key, rowCountsFor(priya, deskWide)), undefined);
eq("a lead still finds the row (their note goes on it)", repo.findLinkByUrl(o.id, key, rowCountsFor(lead, deskWide))?.id, first);
const second = repo.addLink(o.id, url, priya.id, "Sanjeev Shared");
eq("Priya now has her own row", repo.linkEntry(second)?.addedBy, priya.id);
eq("both rows are on the opening", repo.linksByUrl(o.id, key).map((r) => r.addedBy).sort(), [priya.id, thushini.id].sort());
eq("Priya's second paste lands on her own row", repo.findLinkByUrl(o.id, key, rowCountsFor(priya, deskWide))?.id, second);
eq("Priya hears that Thushini also holds them", otherHolders(repo.linksByUrl(o.id, key), priya, deskWide), [thushini.id]);
eq("Thushini hears about Priya", otherHolders(repo.linksByUrl(o.id, key), thushini, deskWide), [priya.id]);
eq("a third TA hears both", otherHolders(repo.linksByUrl(o.id, key), third, deskWide).sort(), [priya.id, thushini.id].sort());
eq("a lead is never told 'also held'", otherHolders(repo.linksByUrl(o.id, key), lead, deskWide), []);

console.log("\nA row a lead added for the TAs still counts for them");
const leadUrl = "https://www.linkedin.com/in/lead-added-test";
const byLead = repo.addLink(o.id, leadUrl, lead.id, "Lead Added");
eq("the TA's paste lands on the lead's row", repo.findLinkByUrl(o.id, linkKey(leadUrl)!, rowCountsFor(priya, deskWide))?.id, byLead);

console.log("\nBy name and company, the same rule");
repo.updateLink(first, { company: "Harbourway Ltd" });
eq("another TA's row is not Priya's match", repo.findLinkByPerson(o.id, "Sanjeev Shared", "Harbourway Ltd", (r) => r.id !== second && rowCountsFor(priya, deskWide)(r)), undefined);
eq("it is Thushini's", repo.findLinkByPerson(o.id, "Sanjeev Shared", "Harbourway Ltd", rowCountsFor(thushini, deskWide))?.id, first);

console.log("\nWhoever shortlists first works them; the other row says so");
const app = { ownerTaId: thushini.id as string | null };
eq("Thushini's row shows her progress", rowApplication({ addedBy: thushini.id }, app, deskWide), { app, takenBy: null });
eq("Priya's row shows who has them, not Thushini's progress", rowApplication({ addedBy: priya.id }, app, deskWide), { app: null, takenBy: thushini.id });
eq("a lead's row keeps showing the TA's progress", rowApplication({ addedBy: lead.id }, app, deskWide), { app, takenBy: null });
const unclaimed = { ownerTaId: null };
eq("nobody has claimed them yet: shown as before", rowApplication({ addedBy: priya.id }, unclaimed, deskWide), { app: unclaimed, takenBy: null });
eq("no application: nothing", rowApplication({ addedBy: priya.id }, null, deskWide), { app: null, takenBy: null });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
