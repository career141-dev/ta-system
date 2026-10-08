/**
 * Referral Search (convex/lib/referralSearch): reading a sentence, deciding who
 * matches, ordering, and folding one person named by many candidates into one row.
 * The model is replaced by a fake asker; nothing here touches a network.
 */
import {
  answers,
  criteriaFromModel,
  groupPeople,
  personKey,
  readCriteria,
  ruleRead,
  scoreReferee,
  termMatches,
  tokens,
  type ReferralCriteria,
  type RefRow,
} from "../convex/lib/referralSearch";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const row = (o: Partial<RefRow> & { id: string }): RefRow => ({
  candidateId: "c1", name: "Nimal Perera", designation: null, company: null, phone: null, email: null, relationship: null, at: 1, ...o,
});
const crit = (o: Partial<ReferralCriteria>): ReferralCriteria => ({
  designations: [], companies: [], name: null, loose: null, needsContact: false, industry: null, summary: "", ...o,
});

console.log("\nMatching words");
eq("noise is dropped: Pvt Ltd, Sri Lanka", tokens("Dialog Axiata PLC (Sri Lanka) Pvt Ltd"), ["dialog", "axiata"]);
eq("H.R. reads as HR", tokens("H.R. Manager"), ["hr", "manager"]);
eq("a company matches its longer legal name", termMatches("Dialog Axiata PLC", "Dialog"), true);
eq("a different company does not", termMatches("Dialogue Systems", "Dialog"), false);
eq("every word of the term must be there", termMatches("Manager - Finance", "HR Manager"), false);
eq("order does not matter", termMatches("Manager, HR", "HR Manager"), true);
eq("plural and singular agree", termMatches("HR Managers", "HR Manager"), true);
eq("Keell is Keells", termMatches("Keells Super", "Keell"), true);
eq("a stub does not match (Di is not Dialog)", termMatches("Dialog", "Di"), false);
eq("nothing matches an empty field", termMatches(null, "Dialog"), false);

console.log("\nReading without a model");
{
  const r = ruleRead("Find all referees who are HR Managers");
  eq("title found, no company", [r.designations[0], r.companies], ["HR Manager", []]);
  eq("HR is spelled out as well", r.designations.includes("Human Resources Manager"), true);
}
eq("company after 'at'", ruleRead("Show me references from people working at Dialog").companies, ["Dialog"]);
{
  const r = ruleRead("HR Managers at Dialog Axiata");
  eq("title and a two-word company", [r.designations[0], r.companies[0]], ["HR Manager", "Dialog Axiata"]);
}
eq("contact words set needsContact", ruleRead("contact details of General Managers").needsContact, true);
eq("GM is also General Manager", ruleRead("GM at Hemas").designations.includes("General Manager"), true);
{
  const r = ruleRead("Dialog");
  eq("one bare word is searched everywhere", [r.loose, r.designations, r.companies], ["Dialog", [], []]);
}

console.log("\nThe model's answer");
eq("unusable JSON is refused", criteriaFromModel(null), null);
eq("empty lists are refused", criteriaFromModel({ designations: [], companies: [] }), null);
{
  const c = criteriaFromModel({ designations: ["HR Manager", " HR Manager ", "Head of HR"], companies: ["Dialog"], needsContact: true, summary: "HR Managers · Dialog" })!;
  eq("duplicates folded, flags kept", [c.designations, c.needsContact], [["HR Manager", "Head of HR"], true]);
}

console.log("\nWho answers the search");
{
  const c = crit({ designations: ["HR Manager"], companies: ["Dialog"] });
  eq("title AND company: both hold", answers(row({ id: "1", designation: "Senior HR Manager", company: "Dialog Axiata PLC" }), c), true);
  eq("right title, wrong company: out", answers(row({ id: "2", designation: "HR Manager", company: "Hemas" }), c), false);
  eq("right company, wrong title: out", answers(row({ id: "3", designation: "Driver", company: "Dialog" }), c), false);
  eq("contact asked for: a row with neither is out", answers(row({ id: "4", designation: "HR Manager", company: "Dialog" }), { ...c, needsContact: true }), false);
  eq("contact asked for: a phone is enough", answers(row({ id: "5", designation: "HR Manager", company: "Dialog", phone: "0771234567" }), { ...c, needsContact: true }), true);
}
{
  const c = crit({ loose: "Dialog" });
  eq("a bare word may be the company", answers(row({ id: "1", company: "Dialog" }), c), true);
  eq("or the name", answers(row({ id: "2", name: "Dialog Silva" }), c), true);
  eq("or nothing", answers(row({ id: "3", company: "Hemas" }), c), false);
}

console.log("\nOrder");
{
  const c = crit({ designations: ["HR Manager", "Head of HR"], companies: ["Dialog"] });
  const typed = scoreReferee(row({ id: "a", designation: "HR Manager", company: "Dialog" }), c);
  const similar = scoreReferee(row({ id: "b", designation: "Head of HR", company: "Dialog" }), c);
  eq("the typed title outranks an equivalent", typed.score > similar.score, true);
  const withContact = scoreReferee(row({ id: "c", designation: "HR Manager", company: "Dialog", phone: "0771", email: "a@b.lk" }), c);
  eq("a phone and an email lift a tie", withContact.score > typed.score, true);
  eq("the pill says why", typed.why, ["Title: HR Manager", "Company: Dialog"]);
  const industry = scoreReferee(row({ id: "d", company: "Keells" }), crit({ companies: ["retail", "Keells"], industry: "retail" }));
  eq("an industry company says so", industry.why, ["retail company: Keells"]);
}

console.log("\nOne person, many rows");
{
  const a = row({ id: "1", candidateId: "c1", name: "Nimal Perera", designation: "HR Manager", company: "Dialog", phone: "077 123 4567" });
  const b = row({ id: "2", candidateId: "c2", name: "N. Perera", designation: "HR Manager", company: "Dialog Axiata", phone: "+94771234567", email: "nimal@dialog.lk" });
  const other = row({ id: "3", candidateId: "c3", name: "Kamal Silva", designation: "HR Manager", company: "Dialog", phone: "0779999999" });
  eq("the same number, written two ways, is one person", personKey(a), personKey(b));
  const c = crit({ designations: ["HR Manager"], companies: ["Dialog"] });
  const people = groupPeople([a, b, other].map((r) => scoreReferee(r, c)));
  eq("two people", people.length, 2);
  const nimal = people.find((p) => p.rowIds.includes("1"))!;
  eq("both candidates are kept", nimal.candidateIds, ["c1", "c2"]);
  eq("the email from the other row is filled in", nimal.email, "nimal@dialog.lk");
  eq("the same candidate twice counts once", groupPeople([a, { ...a, id: "9" }].map((r) => scoreReferee(r, c)))[0].candidateIds, ["c1"]);
  const bare = (id: string, cand: string) => row({ id, candidateId: cand, name: "Sunil Fernando", company: "Hemas", designation: "GM" });
  eq("no number or email: the same name at the same company is one person", groupPeople([bare("x", "c1"), bare("y", "c2")].map((r) => scoreReferee(r, crit({}))))[0].candidateIds.length, 2);
}

console.log("\nClaude, then DeepSeek, then the words");
{
  const good = JSON.stringify({ designations: ["HR Manager"], companies: ["Dialog"], needsContact: false, summary: "HR Managers · Dialog" });
  const never = async (): Promise<string | null> => { throw new Error("should not be asked"); };
  const r1 = await readCriteria("HR managers at Dialog", { claude: async () => "```json\n" + good + "\n```", deepseek: never });
  eq("Claude's answer is used, DeepSeek not asked", [r1.via, r1.criteria.companies], ["claude", ["Dialog"]]);
  const r2 = await readCriteria("HR managers at Dialog", { claude: async () => null, deepseek: async () => good });
  eq("Claude gave nothing: DeepSeek", r2.via, "deepseek");
  const r3 = await readCriteria("HR managers at Dialog", { claude: async () => { throw new Error("busy"); }, deepseek: async () => "not json" });
  eq("both fail: the words", [r3.via, r3.criteria.designations[0], r3.criteria.companies[0]], ["words", "HR Manager", "Dialog"]);
  const r4 = await readCriteria("contact details of GM at Hemas", { claude: async () => good, deepseek: never });
  eq("a contact request the model missed is kept", r4.criteria.needsContact, true);
  const r5 = await readCriteria("Dialog", { claude: async () => JSON.stringify({ designations: [], companies: ["Dialog"] }), deepseek: never });
  eq("a bare word stays a bare word", [r5.criteria.loose, r5.criteria.companies], ["Dialog", []]);
  const retail = JSON.stringify({ designations: [], companies: ["Keells", "Cargills", "Arpico"], industry: "retail", needsContact: true });
  const r6 = await readCriteria("Contact details of referees from retail companies", { claude: async () => retail, deepseek: never });
  eq("one leftover word in a sentence does not discard the model's company list", [r6.criteria.loose, r6.criteria.companies], [null, ["Keells", "Cargills", "Arpico"]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
