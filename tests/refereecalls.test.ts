import { classifyFeedback, resultOf } from "@/lib/refereeCalls";
import { eodEmailHtml, type EffortRow } from "@/lib/eod-format";

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}\n  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(actual)}`);
  }
}

const examples: [string, "positive" | "negative"][] = [
  ["Have a contact, first i have to check if the person is interested and if yes will share you the contact.", "positive"],
  ["He said he cannot give his number, but he will pass this number to him and if he is okay then he will call back", "positive"],
  ["will find the number and whatsapp me", "positive"],
  ["No contacts available", "negative"],
  ["At the moment i have no contacts, if i have any contacts will share.", "negative"],
  ["No answer", "negative"],
  ["Not responding", "negative"],
  ["Wrong number in the database, could not find his linkedin.", "negative"],
  ["Currently overseas", "negative"],
  ["Previously worked in nawaloka, no contact available", "negative"],
  ["spoke to him", "negative"],
];
for (const [feedback, expected] of examples) eq(`classifies “${feedback}”`, classifyFeedback(feedback), expected);
eq("an explicit preview move wins", resultOf({ feedback: "No answer", result: "positive" }), "positive");
eq("a null preview result uses the classifier", resultOf({ feedback: "Number received", result: null }), "positive");

const effort: EffortRow = {
  date: "23 Oct",
  assignee: "Nimali",
  hundredOrFollowUp: "100%",
  lEffort: 10,
  sets: 1,
  da: 0,
  scoop: 0,
  l: 0,
  post: 0,
  addOns: 0,
  backUp: 0,
};
const html = (refereeCalls?: Parameters<typeof eodEmailHtml>[0]["refereeCalls"]) => eodEmailHtml({ rows: [], effort, senderName: "Nimali", refereeCalls });
eq("no calls leaves the existing email unchanged", html().includes("Referee calls"), false);
const negatives = html([{ company: "Medihelp", referral: "Ravi", contactNumber: "", feedback: "No answer", result: "negative" }]);
eq("only negatives omits the Positive box", negatives.includes("Positive – contacts available"), false);
eq("only negatives includes Not successful", negatives.includes("Not successful"), true);
const both = html([
  { company: "A", referral: "One", contactNumber: "071", feedback: "Number received", result: "positive" },
  { company: "B", referral: "Two", contactNumber: "072", feedback: "No answer", result: "negative" },
]);
eq("Positive appears before Not successful", both.indexOf("Positive – contacts available") < both.indexOf("Not successful"), true);
const positiveBox = both.slice(both.indexOf("Positive – contacts available"), both.indexOf("Not successful"));
const negativeBox = both.slice(both.indexOf("Not successful"));
eq("the Positive box numbers from one", /<td[^>]*>1<\/td>/.test(positiveBox), true);
eq("the Not successful box numbers from one", /<td[^>]*>1<\/td>/.test(negativeBox), true);
const escaped = html([{ company: "<script>alert(1)</script>", referral: "R", contactNumber: "1", feedback: "Number received", result: "positive" }]);
eq("email values are escaped", escaped.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !escaped.includes("<script>alert(1)</script>"), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
