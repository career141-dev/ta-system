import { readNumbers, readNames } from "@/lib/reviewReply";

let pass = 0, fail = 0;
const list = ["Nimal Perera","Kasun Silva","Tharindu Fernando","Dilani Jayasuriya","Ruwan Alwis"]
  .map((name, i) => ({ applicationId: `a${i + 1}`, name }));
const say = (reply: string) => {
  const d = readNumbers(reply, list);
  const m: Record<string, string> = {};
  for (const x of d) m[x.applicationId.replace("a", "")] = x.outcome === "shortlisted" ? "Y" : x.outcome === "rejected" ? "N" : "H";
  return [1,2,3,4,5].map(n => m[String(n)] ?? "-").join("");
};
const eq = (reply: string, want: string) => {
  const got = say(reply);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} "${reply}"  ->  ${got}${ok ? "" : "  want " + want}`);
};

console.log("\nY = shortlisted, N = rejected, H = hold, - = not mentioned\n");
console.log("plain lists");
eq("Shortlist 1, 3 and 5", "Y-Y-Y");
eq("Please proceed with 1 and 3", "Y-Y--");
eq("Reject 2 and 4", "-N-N-");
eq("Hold 5", "----H");

console.log("\ntwo instructions in one sentence — the case that was broken");
eq("Please proceed with 1 and 3, not 2", "YNY--");
eq("Shortlist 1 and 2 but not 3", "YYN--");
eq("Take forward 1, 2 and 4 except 4", "YY-N-");
eq("Go ahead with 1 and 5, other than 5", "Y---N");

console.log("\ntwo sentences");
eq("Shortlist 1, 3 and 5. Reject 2 and 4.", "YNYNY");
eq("Proceed with 1. Hold 2. Drop 3.", "YHN--");

console.log("\nranges");
eq("Shortlist 2-4", "-YYY-");
eq("Take 1 to 3, reject 4", "YYYN-");

console.log("\nhold must beat reject");
eq("Not sure about 3", "--H--");
eq("I am not certain on 2, shortlist 1", "YH---");

console.log("\nnothing to read");
eq("Thanks, will look tomorrow", "-----");
eq("Looks good", "-----");

console.log("\nby name");
const byName = readNames("Please proceed with Nimal and Tharindu, not Kasun", list);
const nm: Record<string,string> = {};
for (const x of byName) nm[x.applicationId] = x.outcome;
const okNames = nm.a1 === "shortlisted" && nm.a3 === "shortlisted" && nm.a2 === "rejected";
okNames ? pass++ : fail++;
console.log(`${okNames ? "  ok  " : "  FAIL"} names: ${JSON.stringify(nm)}`);


// ─── The 13 September audit's two reply failures ─────────────────────────────
// Both are the same class of fault: a decision made about somebody the
// reviewer never decided about. They are tested first because they are the
// ones that put a rejected person in front of a client.

console.log("\nnegation");
eq("Do not reject 1.", "-----");
eq("Please don't reject 2.", "-----");
eq("Do not shortlist 3.", "--N--");
eq("Don't proceed with 4.", "---N-");
eq("Do not take 2 forward.", "-N---");
eq("Proceed with 1 and 3, not 2.", "YNY--");

console.log("\nnumbers that are not candidates");
eq("Please proceed with 1. Interview at 2 pm.", "Y----");
eq("Shortlist 1. Call them at 3pm.", "Y----");
eq("Take 1 forward. Interview on the 2nd.", "Y----");
eq("Shortlist 1. They want 3 weeks notice.", "Y----");
eq("Proceed with 1. Budget is 5 lakhs.", "Y----");
eq("Go ahead with 1. Meeting 12/3 at 10:30.", "Y----");
eq("Shortlist 1. He has 4 years experience.", "Y----");
eq("Approve 2. Salary 450,000 and 15% bonus.", "-Y---");

console.log("\nthe carry does not cross a full stop");
eq("Shortlist 1, 3 and 5. 2 and 4 are weak.", "YNYNY");
eq("Reject 1. 2 and 3 are fine, take them.", "NYY--");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
