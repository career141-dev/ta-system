// A CV emailed to shortlists@ is our own Prepared CV, CAREER141 box on it. When
// it is someone we hold it must write nothing onto them: no details (2 Oct) and
// no CV file, or the next Prepared CV draws a second box over the first.
// Source-level, like the other wiring guards: it checks each link in the chain.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (l: string, cond: boolean) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "  FAIL"} ${l}`);
};
const src = (p: string) => readFileSync(p, "utf8");

const process_ = src("convex/mailIntake/process.ts");
const ingestion = src("convex/pipeline/ingestion.ts");
const extraction = src("convex/cvs/cvExtraction.ts");
const candidates = src("convex/candidates/candidates.ts");
const schema = src("convex/schema.ts");

ok("shortlists@ ingestion marks its uploads as shortlist copies", /campaign: `TA System mail intake[^`]*`, shortlistCopy: true/.test(process_));
ok("ingestCvs passes the mark to processCvIngestion", /opts\.shortlistCopy \? \{ shortlistCopy: true \}/.test(process_));
ok("processCvIngestion stores the mark on the upload", /args\.shortlistCopy \? \{ shortlistCopy: true \}/.test(ingestion));
ok("cvUploads has the field", /shortlistCopy: v\.optional\(v\.boolean\(\)\)/.test(schema));
ok("extraction reads the mark and hands it to the candidate write", /const shortlistCopy = !!cvUpload\?\.shortlistCopy/.test(extraction) && /\.\.\.\(shortlistCopy \? \{ shortlistCopy: true \} : \{\}\)/.test(extraction));
ok("a matched person is returned before any patch is written",
  candidates.indexOf("if (shortlistCopy) return { targetCandidateId: targetId, keptAsIs: true }") > 0 &&
  candidates.indexOf("if (shortlistCopy) return") < candidates.indexOf("await ctx.db.patch(targetId, definedPatches)"));
ok("referees and embedding are not rewritten for a person we hold", /!keptAsIs && extracted\.referees/.test(extraction) && /if \(!keptAsIs\) \{/.test(extraction));
ok("a shortlist copy is not matched against every open job", /else if \(shortlistCopy\)/.test(extraction));

// 22 Oct: the TA's own end-of-day copy always carries CVs, and was filed as the
// Director's shortlist because the copy was only recognised without them.
const ownCopy = process_.indexOf("if (originalTrackedCopy) {");
ok("the TA's own tracked copy is skipped before the CV path", ownCopy > 0 && ownCopy < process_.indexOf("if (cvs.length === 0) {", ownCopy) && ownCopy < process_.indexOf("parseHouseSubject(subject)"));
ok("a shortlist subject moves people only from a recorded Director address", /if \(house && !fromDirector\) \{[\s\S]{0,200}outcome: "held"/.test(process_));
ok("the director address list uses the desk role", /mapUser\(u\)\.role === "director"/.test(src("convex/mailIntake/shortlist.ts")));
ok("a mail-filed move records the Director's decision", /recordShortlistDecision\(ctx/.test(src("convex/mailIntake/shortlist.ts")));
ok("a hand move to Director Shortlist records the decision", /target === "director_shortlist" \|\| target === "client_review"\) \{\s*await recordShortlistDecision/.test(src("convex/ta/applications.ts")));
ok("an automatic read applies nothing a person must check", /&& reviewReasons\.length === 0/.test(src("convex/mailIntake/decisions.ts")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
