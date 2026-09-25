/**
 * The JD chat (25 Sep): the TA asks the AI for changes until they approve.
 * - the thread is kept per opening, in order
 * - the AI's "CHANGES:" line is split off the JD
 * - the Job details stop following the notes once the chat begins
 * - CV scoring waits only for a JD that is waiting for approval
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoringWaitsForJd } from "../convex/lib/jdGate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-jdchat-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { splitChanges } = await import("@/lib/headhunt");
const { chatHistory, detailsFollowNotes } = await import("@/lib/jdChat");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe thread is kept per opening, oldest first");
repo.reset();
const [a, b] = repo.openings();
const ta = repo.users().find((u) => u.role === "ta")!;
repo.addJdChat({ openingId: a.id, role: "user", body: "Add CIMA", jdMarkdown: null, byUserId: ta.id, at: 2000 });
repo.addJdChat({ openingId: a.id, role: "assistant", body: "Added CIMA under Qualifications.", jdMarkdown: "## JD v2", byUserId: null, at: 3000 });
repo.addJdChat({ openingId: b.id, role: "user", body: "Shorter", jdMarkdown: null, byUserId: ta.id, at: 1000 });
repo.addJdChat({ openingId: a.id, role: "user", body: "Earlier request", jdMarkdown: null, byUserId: ta.id, at: 1000 });
eq("opening A has its three turns, in time order", repo.jdChat(a.id).map((m) => m.body), ["Earlier request", "Add CIMA", "Added CIMA under Qualifications."]);
eq("opening B has only its own", repo.jdChat(b.id).map((m) => m.body), ["Shorter"]);
eq("an answer keeps the JD it produced", repo.jdChat(a.id)[2].jdMarkdown, "## JD v2");

console.log("\nthe history the AI is shown leaves out a failed answer");
repo.addJdChat({ openingId: b.id, role: "assistant", body: "Could not revise", jdMarkdown: null, byUserId: null, at: 1100, failed: true });
eq("failed turn dropped", chatHistory(repo.jdChat(b.id)), [{ role: "user", body: "Shorter" }]);

console.log("\nthe Job details follow the notes only until the chat begins");
eq("no chat: they follow the notes", detailsFollowNotes([]), true);
eq("a restored version alone does not count as the TA asking", detailsFollowNotes([{ role: "assistant" }]), true);
eq("once the TA has asked: they wait for approval", detailsFollowNotes(repo.jdChat(a.id)), false);

console.log("\nthe AI's one-line summary is split off the JD");
eq("plain CHANGES line", splitChanges("## Finance Manager\n\nText.\n\nCHANGES: Added CIMA."), { text: "## Finance Manager\n\nText.", changes: "Added CIMA." });
eq("bold CHANGES line", splitChanges("## JD\n\n**CHANGES:** Removed the licence."), { text: "## JD", changes: "Removed the licence." });
eq("no CHANGES line: the whole text is the JD", splitChanges("## JD\n\nText."), { text: "## JD\n\nText.", changes: "Revised the JD." });
eq("only the first line of the summary is kept", splitChanges("## JD\nCHANGES: One.\nStray note."), { text: "## JD", changes: "One." });

console.log("\nCV scoring waits only for a JD waiting for approval");
eq("pending approval: waits", scoringWaitsForJd({ jdStatus: "pending_ta_approval" }), true);
eq("approved: scored", scoringWaitsForJd({ jdStatus: "approved" }), false);
eq("older pipeline job marked draft: scored as before", scoringWaitsForJd({ jdStatus: "draft" }), false);
eq("no status: scored as before", scoringWaitsForJd({}), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
