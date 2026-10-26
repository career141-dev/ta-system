/**
 * The AI reader's safety check and the set rebuilt from CV file names
 * (convex/lib/directorReplyAi.ts, 23 Oct). Pure — no model is called.
 */
import { matchCvFiles, nameFromCvFile, readAiAnswer, someoneNamed } from "../convex/lib/directorReplyAi";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const roster = [
  { applicationId: "a1", name: "Rizny Ahamed" },
  { applicationId: "a2", name: "Kanishka Perera" },
  { applicationId: "a3", name: "Dinuksha Thanthriwaththa" },
  { applicationId: "a4", name: "Chamika Balasuriya" },
];

console.log("\nthe owner's rules, from the model's answer");
const r = readAiAnswer(JSON.stringify({
  decisions: [
    { n: 1, decision: "shortlisted", reason: "", task: "" },
    { n: 2, decision: "shortlisted", reason: "", task: "follow up on updated CV" },
    { n: 3, decision: "optional", reason: "expensive", task: "" },
    { n: 4, decision: "no_decision", reason: "", task: "what's her age?" },
  ],
  namesNotInList: [],
  confident: true,
}), roster);
eq("clear when every candidate is read once, confidently", r.clear, true);
eq("shortlisted and optional go to the shortlist; a question stays (hold)", r.decisions.map((d) => d.outcome), ["shortlisted", "shortlisted", "shortlisted", "hold"]);
eq("optional is noted", r.decisions[2].evidence, "Optional — expensive");
eq("the TA's task is kept", r.decisions[3].evidence, "TA task: what's her age?");
eq("not shortlisted becomes rejected", readAiAnswer({ decisions: [{ n: 1, decision: "not_shortlisted", reason: "sourced previously" }], confident: true }, roster.slice(0, 1)).decisions[0].outcome, "rejected");

console.log("\nnothing acts on a doubtful answer");
eq("not confident → review", readAiAnswer({ decisions: [{ n: 1, decision: "shortlisted" }], confident: false }, roster.slice(0, 1)).clear, false);
eq("a person missing → review", readAiAnswer({ decisions: [{ n: 1, decision: "shortlisted" }], confident: true }, roster.slice(0, 2)).clear, false);
eq("a name not in the set → review", readAiAnswer({ decisions: [{ n: 1, decision: "shortlisted" }], namesNotInList: ["Ruwan"], confident: true }, roster.slice(0, 1)).clear, false);
eq("a number outside the set → review", readAiAnswer({ decisions: [{ n: 9, decision: "shortlisted" }], confident: true }, roster.slice(0, 1)).clear, false);
eq("an unknown decision word → review", readAiAnswer({ decisions: [{ n: 1, decision: "maybe" }], confident: true }, roster.slice(0, 1)).clear, false);
eq("not JSON at all → review", readAiAnswer("sorry, I cannot", roster).clear, false);
eq("JSON in a code fence is read", readAiAnswer('```json\n{"decisions":[{"n":1,"decision":"shortlisted"}],"confident":true}\n```', roster.slice(0, 1)).clear, true);

console.log("\nthe set from the CV file names");
eq("the name of a CV file", nameFromCvFile("Rizny Ahamed - Career141.pdf"), "Rizny Ahamed");
eq("…in capitals too", nameFromCvFile("ANURA SHANTHA - CAREER141.pdf"), "ANURA SHANTHA");
const people = [
  { applicationId: "x1", name: "Rizny Ahamed" },
  { applicationId: "x2", name: "Kanishka Perera" },
  { applicationId: "x3", name: "Ilyas Mohamed" },
  { applicationId: "x4", name: "Kasun Perera" },
];
const m = matchCvFiles(["Rizny Ahamed - Career141.pdf", "KANISHKA PERERA - CAREER141.pdf", "ILYAS - CAREER141.pdf", "DeltaSpike - FINANCE MANAGER - 2026-10-22.xlsx", "image001.png"], people);
eq("each CV matched to its candidate; the table and images ignored", m.roster.map((x) => x.applicationId), ["x1", "x2", "x3"]);
eq("a surname two people share does not pick one", matchCvFiles(["Perera - Career141.pdf"], people).unmatched, ["Perera"]);
eq("a CV that matches nobody is reported", matchCvFiles(["Nimal Silva - Career141.pdf"], people).unmatched, ["Nimal Silva"]);

console.log("\nsomeone already on the opening");
const twice = [{ name: "Akalanka Samarawickrama" }, { name: "Akalanka Samarawickrama" }, { name: "Sameera Lokuwithana" }];
eq("the same person twice is still there", someoneNamed("Akalanka Samarawickrama - Career141.pdf", twice), true);
eq("one shared word is not enough for two", someoneNamed("Akalanka Perera.pdf", twice), false);
eq("nobody by that name", someoneNamed("Nimal Silva.pdf", twice), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
