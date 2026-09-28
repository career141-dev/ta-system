/**
 * The Bin (28 Sep): Delete moves a client or an opening aside for seven days,
 * Restore puts it back exactly as it was, and the clean-up removes it after.
 * Run against a disposable copy of the seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-bin-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { BIN_MS, daysLeft, isDueForPurge, isGone } = await import("@/lib/bin");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const DAY = 86_400_000;

console.log("\nthe clock");
eq("7 days left the moment it is binned", daysLeft(0, 0), 7);
eq("1 day left an hour before the end", daysLeft(0, BIN_MS - 3_600_000), 1);
eq("not due a minute early", isDueForPurge(0, BIN_MS - 60_000), false);
eq("due at seven days", isDueForPurge(0, BIN_MS), true);
eq("a binned row has left the desk", isGone({ binnedAt: 5 }), true);
eq("a row being deleted has left the desk", isGone({ deletingAt: 5 }), true);
eq("an ordinary row has not", isGone({}), false);

console.log("\nan opening goes to the Bin and comes back whole");
repo.reset();
const lead = repo.users().find((u) => u.role === "director")!;
const candidatesBefore = repo.candidates().length;
// The first opening with applications that is not refused (one with an offer
// or a placement has to be closed, not deleted).
let busy: ReturnType<typeof repo.openings>[number] | undefined;
let appsBefore = 0, postsBefore = 0;
for (const o of repo.openings().filter((x) => repo.applications(x.id).length > 0)) {
  const apps = repo.applications(o.id).length, posts = repo.jobPosts(o.id).length;
  if (repo.binOpening(o.id, lead.id).ok) {
    busy = o; appsBefore = apps; postsBefore = posts;
    break;
  }
}
eq("an opening with applications can be binned", !!busy, true);
if (busy) {
  const id = busy.id;
  eq("it leaves the openings list", repo.opening(id), null);
  eq("its applications leave with it", repo.applications(id).length, 0);
  eq("no candidate is deleted", repo.candidates().length, candidatesBefore);
  const inBin = repo.bin().find((b) => b.id === id);
  eq("it is in the Bin", inBin?.kind, "opening");
  eq("with who binned it", inBin?.binnedBy, lead.name);
  eq("due seven days on", inBin ? inBin.purgeAt - inBin.binnedAt : null, BIN_MS);

  eq("restore works", repo.restoreFromBin("opening", id).ok, true);
  eq("the opening is back", repo.opening(id)?.title, busy.title);
  eq("with every application", repo.applications(id).length, appsBefore);
  eq("and every post", repo.jobPosts(id).length, postsBefore);
  eq("and it is out of the Bin", repo.bin().some((b) => b.id === id), false);
}

console.log("\na client with an opening on the desk stays");
repo.reset();
const withWork = repo.clients().find((c) => repo.openings().some((o) => o.clientId === c.id))!;
eq("refused", repo.binClient(withWork.id, lead.id).ok, false);
eq("still listed", !!repo.client(withWork.id), true);

console.log("\nbinning its openings lets the client go; restoring one brings the client back");
// A client none of whose openings has an offer or placement on it.
let freed: typeof withWork | undefined;
let theirs: ReturnType<typeof repo.openings> = [];
for (const c of repo.clients()) {
  repo.reset();
  const mine = repo.openings().filter((o) => o.clientId === c.id);
  if (mine.length > 0 && mine.every((o) => repo.binOpening(o.id, lead.id).ok)) {
    freed = c;
    theirs = mine;
    break;
  }
}
eq("found a client whose openings can all be binned", !!freed, true);
if (freed) {
  eq("the client goes to the Bin", repo.binClient(freed.id, lead.id).ok, true);
  eq("and leaves the clients list", repo.client(freed.id), null);
  eq("it cannot be deleted for good while its openings are in the Bin", repo.deleteFromBin("client", freed.id).ok, false);
  repo.restoreFromBin("opening", theirs[0].id);
  eq("restoring an opening restores its client", repo.client(freed.id)?.name, freed.name);
}

console.log("\nthe clean-up");
repo.reset();
let spare = repo.clients().find((c) => !repo.openings().some((o) => o.clientId === c.id));
if (!spare) {
  const id = repo.addClient({ name: "Bin Test Client", industry: "Retail" });
  spare = repo.client(id)!;
}
repo.binClient(spare.id, lead.id);
eq("nothing goes before seven days", repo.emptyBin(Date.now() + 6 * DAY), 0);
eq("it goes at seven days", repo.emptyBin(Date.now() + 7 * DAY + 1000), 1);
eq("and cannot be restored after", repo.restoreFromBin("client", spare.id).ok, false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
