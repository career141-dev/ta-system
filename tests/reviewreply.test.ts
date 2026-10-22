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

console.log("\nordinals and select verbs");
eq("3rd one only", "--Y--");
eq("1st and 3rd", "Y-Y--");
eq("Select 1 and 2", "YY---");
eq("Selected 2", "-Y---");
eq("Choose 4", "---Y-");
eq("First and third are good", "Y-Y--");

console.log("\nsingle candidate sets");
const singleList = [{ applicationId: "a1", name: "Gajuurthi" }];
const testSingle = (reply: string, want: string) => {
  const d = readNumbers(reply, singleList);
  const got = d.length ? (d[0].outcome === "shortlisted" ? "Y" : d[0].outcome === "rejected" ? "N" : "H") : "-";
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} single: "${reply}" -> ${got}${ok ? "" : " want " + want}`);
};
testSingle("select this", "Y");
testSingle("selected", "Y");
testSingle("select", "Y");
testSingle("proceed", "Y");
testSingle("yes", "Y");
testSingle("reject", "N");
testSingle("not suitable", "N");

console.log("\nextractReplyText header stripping");
const { extractReplyText } = await import("@/lib/reviewReply");
const raw1 = "select this\n\nOn Fri, Sep 25, 2026 at 10:07 AM Gajuurthi <gajuurthi@example.com> wrote:\n> Set 1 sent";
const clean1 = extractReplyText(raw1);
const ok1 = clean1 === "select this";
ok1 ? pass++ : fail++;
console.log(`${ok1 ? "  ok  " : "  FAIL"} extractReplyText 1: "${clean1}"`);

const raw2 = "3rd one only --- 3rd one only On Thu, Sep 24, 2026 at 11:33 AM wrote:\nSome old text";
const clean2 = extractReplyText(raw2);
const ok2 = clean2 === "3rd one only";
ok2 ? pass++ : fail++;
console.log(`${ok2 ? "  ok  " : "  FAIL"} extractReplyText 2: "${clean2}"`);

const rawHtml = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div dir="ltr">shortlist the 1st one</div><br><div class="gmail_quote_container"><div dir="ltr" class="gmail_attr">On Fri, Sep 25, 2026 at 2:16 PM Gajani Linathiranthan &lt;<a href="mailto:Gajani@career141.com">Gajani@career141.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;"><table><tr><td>1</td><td>Shehan PW</td></tr><tr><td>2</td><td>MA RUZNY AHAMED</td></tr></table></blockquote></div></body></html>`;
const cleanHtml = extractReplyText(rawHtml);
const okHtml = cleanHtml === "shortlist the 1st one";
okHtml ? pass++ : fail++;
console.log(`${okHtml ? "  ok  " : "  FAIL"} extractReplyText HTML: "${cleanHtml}"`);

console.log("\na number inside other words is not a pick (review of #56)");
eq("1, 3", "Y-Y--");
eq("busy with 2 interviews this week, will reply tomorrow", "-----");
eq("I have 3 concerns about this set", "-----");

console.log("\nthe shortlists@ misreads (22 Oct), read the same way here");
eq("1 and 3 selected, 2 not suitable", "YNY--");
eq("Hi all, please proceed with 1 and 3", "Y-Y--");
eq("Thanks all. Shortlist 1", "Y----");
eq("Set 2: proceed with 1", "Y----");
eq("SET 02 - shortlist 4", "---Y-");
eq("Shortlist all except 2", "YNYYY");
eq("Interview 1 and 3", "Y-Y--");

console.log("\nsilence never rejects an unmentioned candidate");
const { withUnpickedRejected } = await import("@/lib/reviewReply");
const ids5 = ["a1", "a2", "a3", "a4", "a5"];
const picked = withUnpickedRejected({ decisions: [{ applicationId: "a2", outcome: "shortlisted", note: null }], method: "numbers", unmatched: [] }, ids5);
const okAll = picked.length === 1 && picked[0]?.applicationId === "a2";
okAll ? pass++ : fail++;
console.log(`${okAll ? "  ok  " : "  FAIL"} one picked, four left unchanged`);
const unsure = withUnpickedRejected({ decisions: [{ applicationId: "a2", outcome: "shortlisted", note: null }], method: "numbers", unmatched: ["what about the others?"] }, ids5);
const okUnsure = unsure.length === 1;
okUnsure ? pass++ : fail++;
console.log(`${okUnsure ? "  ok  " : "  FAIL"} a clause it could not read: nobody else is marked`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
