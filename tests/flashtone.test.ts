import { flashTone } from "@/lib/flashTone";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nan explicit tone always wins (21 September)");
eq("ok stays ok even with failure words", flashTone("Follow-up stopped. Nothing further will be sent.", "ok"), "ok");
eq("error stays error", flashTone("Saved.", "error"), "error");
eq("note stays note", flashTone("Added.", "note"), "note");
eq("an unknown tone is ignored", flashTone("Saved.", "loud"), "ok");

console.log("\nwithout a tone, the wording decides (older redirects)");
eq("saved is a success", flashTone("Saved."), "ok");
eq("details saved is a success", flashTone("Job details saved. Matching is re-running against them."), "ok");
eq("not sent is a failure", flashTone("Not sent: the mailbox refused it"), "error");
eq("could not is a failure", flashTone("That move could not be made."), "error");
eq("a request to fill a field is a failure", flashTone("Paste the CV text first."), "error");
eq("an invalid email is a failure", flashTone("That is not an email address."), "error");
eq("a placement without a date is a failure", flashTone("A placement needs a join date."), "error");
eq("only-a-lead is a failure", flashTone("Only a lead, director or admin can delete an opening. Close it instead."), "error");
eq("not due yet is in between", flashTone("The next message is not due until 22 Sep."), "note");
eq("nothing owed is in between", flashTone("Nothing is owed on this one right now."), "note");
eq("already there is in between", flashTone("Already in EHS Manager's pipeline."), "note");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
