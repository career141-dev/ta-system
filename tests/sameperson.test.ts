/**
 * Is a LinkedIn profile someone we already hold? (convex/lib/samePerson).
 * The two ways it can go wrong both matter: a second record for the same
 * person, and one person's CV shown for somebody else with the same name.
 */
import { companyMatch, compareNames, cvSearchScore, jobYears, sameSchool, linkedinVariants, namesAgree, phoneKey, profileSlug, sameCompany, samePerson } from "../convex/lib/samePerson";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe pieces");
eq("a profile is its slug, whatever the country or tail", [profileSlug("https://lk.linkedin.com/in/Kajan-T-123/?utm=x"), profileSlug("www.linkedin.com/in/kajan-t-123")], ["kajan-t-123", "kajan-t-123"]);
eq("a company page is not a profile", profileSlug("https://www.linkedin.com/company/swen"), null);
eq("every way the address is written is looked up", linkedinVariants("x").includes("https://lk.linkedin.com/in/x/"), true);
eq("0771234567 and +94 77 123 4567 are one line", phoneKey("0771234567") === phoneKey("+94 77 123 4567"), true);
eq("names in either order", compareNames("Kajan Thiyagamoorthy", "THIYAGAMOORTHY, Kajan"), "exact");
eq("titles are not part of the name", compareNames("Mr. Hashan De Mel", "Hashan De Mel"), "exact");
eq("initials and surname", compareNames("K. Thiyagamoorthy", "Kajan Thiyagamoorthy"), "initials");
eq("Sri Lankan initials", compareNames("W.M.K. Perera", "Wijesinghe Mudiyanselage Kasun Perera"), "initials");
eq("an initial that fits nobody is no match", compareNames("R. Thiyagamoorthy", "Kajan Thiyagamoorthy"), null);
eq("a shared first name is no match", compareNames("Kajan Perera", "Kajan Thiyagamoorthy"), null);
eq("one word is not enough", compareNames("Kajan", "Kajan"), null);
eq("SWEN Container Line (Pvt) Ltd is SWEN Container Line", sameCompany("SWEN Container Line (Pvt) Ltd", "Swen Container Line"), true);
eq("different companies", sameCompany("SWEN Container Line", "Pacific Container Line"), false);

console.log("\ncertain: linked without asking");
const cv = { fullName: "Kajan Thiyagamoorthy", email: "kajan.t@gmail.com", phone: "077 123 4567", currentEmployer: "SWEN Container Line", currentTitle: "Documentation Executive", location: "Colombo", employers: ["Pacific Container Line", "SWEN Container Line"] };
eq("the same LinkedIn profile", samePerson({ linkedinUrl: "https://www.linkedin.com/in/kajan-t" }, { ...cv, linkedinUrl: "https://lk.linkedin.com/in/kajan-t/" }).strength, "same");
eq("the same email and the same name", samePerson({ name: "Kajan Thiyagamoorthy", email: "Kajan.T@gmail.com " }, cv).strength, "same");
eq("the same phone, written differently, and initials that fit", samePerson({ name: "K. Thiyagamoorthy", phone: "+94771234567" }, cv).strength, "same");
eq("the same full name at the same company", samePerson({ name: "Kajan Thiyagamoorthy", company: "SWEN Container Line (Pvt) Ltd" }, cv), { strength: "same", reasons: ["Same name", "Both at SWEN Container Line"] });
eq("…or a company they worked at before", samePerson({ name: "Kajan Thiyagamoorthy", company: "Pacific Container Line" }, cv).strength, "same");

console.log("\npossible: a TA confirms");
eq("initials, surname and a shared employer", samePerson({ name: "K. Thiyagamoorthy", company: "SWEN Container Line" }, cv).strength, "possible");
eq("the same name and a similar title, but a new employer", samePerson({ name: "Kajan Thiyagamoorthy", company: "Ceyline Shipping", title: "Senior Documentation Executive" }, cv).strength, "possible");

console.log("\nnot the same person");
eq("the same name, nothing else agreeing", samePerson({ name: "Kajan Thiyagamoorthy", company: "Dialog Axiata", title: "Software Engineer", location: "Jaffna" }, cv).strength, "none");
eq(
  "their record has a different LinkedIn profile — two people, however alike",
  samePerson({ name: "Kajan Thiyagamoorthy", company: "SWEN Container Line", linkedinUrl: "https://www.linkedin.com/in/kajan-other" }, { ...cv, linkedinUrl: "https://www.linkedin.com/in/kajan-t" }).strength,
  "none",
);
eq("a similar name is not the same name", samePerson({ name: "Kajendran Thiyagarajah", company: "SWEN Container Line" }, cv).strength, "none");

console.log("\nshared contact details are not proof on their own (1 Oct)");
eq("same phone, a different name: a TA checks", samePerson({ name: "Nimal Perera", phone: "+94771234567" }, cv).strength, "possible");
eq("same email, no name to compare: a TA checks", samePerson({ email: "kajan.t@gmail.com" }, cv).strength, "possible");
eq("a company inside another's name is not the same company", companyMatch("Bank of Ceylon", "Commercial Bank of Ceylon"), "close");
eq("…so the same name there is only possible", samePerson({ name: "Nimal Perera", company: "Bank of Ceylon" }, { fullName: "Nimal Perera", currentEmployer: "Commercial Bank of Ceylon" }).strength, "possible");
eq("the same company, written differently, is the same", companyMatch("SWEN Container Line (Pvt) Ltd", "Swen Container Line"), "same");
eq("self employed is nobody's company", companyMatch("Self Employed", "Self-employed"), null);
eq("names agree: initials", namesAgree("W.M.K. Perera", "Wijesinghe Mudiyanselage Kasun Perera"), true);
eq("names disagree", namesAgree("Nimal Perera", "Kasun Perera"), false);

console.log("\nFind CV: who a TA is shown, best first (1 Oct)");
{
  const held = { fullName: "Kasun Perera", currentEmployer: "John Keells Holdings", currentTitle: "Finance Manager", employers: ["Hayleys"] };
  eq("certain: same name at the same company", cvSearchScore({ name: "Kasun Perera", company: "John Keells Holdings" }, held)?.strength, "same");
  eq("the same name at a NEW company is still shown — the matching misses these", cvSearchScore({ name: "Kasun Perera", company: "Dialog Axiata" }, held)?.strength, "name");
  eq("…below a certain match", (cvSearchScore({ name: "Kasun Perera", company: "Dialog Axiata" }, held)?.score ?? 0) < 100, true);
  eq("a longer name with the same first name and surname is shown", cvSearchScore({ name: "Kasun Perera" }, { fullName: "Kasun Madushanka Perera" })?.reasons, ["Name partly the same"]);
  eq("only the surname shared: not shown", cvSearchScore({ name: "Nimal Perera" }, held), null);
  // The extension reads their whole LinkedIn history: a job change since the CV still matches.
  eq(
    "moved on since their CV: LinkedIn says Dialog now, John Keells before — the same person",
    samePerson({ name: "Kasun Perera", company: "Dialog Axiata", employers: ["Dialog Axiata", "John Keells Holdings PLC"] }, held).strength,
    "same",
  );
  eq(
    "…but a shared past company with a different name is nobody",
    samePerson({ name: "Ruwan Silva", company: "Dialog Axiata", employers: ["John Keells Holdings"] }, held).strength,
    "none",
  );
  eq("a different LinkedIn profile on their record: not shown", cvSearchScore({ name: "Kasun Perera", linkedinUrl: "linkedin.com/in/kasun-a" }, { ...held, linkedinUrl: "linkedin.com/in/kasun-b" }), null);
}

console.log("\njob years and university make it certain (1 Oct)");
{
  eq("LinkedIn dates read as years", jobYears("Jan 2018 - Dec 2022 · 5 yrs"), { from: 2018, to: 2022 });
  eq("…still there", jobYears("Mar 2019 - Present · 5 yrs 7 mos"), { from: 2019, to: null });
  eq("no dates", jobYears(null), { from: null, to: null });
  eq("the same university, written two ways", sameSchool("University of Moratuwa", "Moratuwa University"), true);
  eq("two different universities", sameSchool("University of Moratuwa", "University of Kelaniya"), false);
  const cvHeld = {
    fullName: "Kasun Perera",
    currentEmployer: "Hayleys PLC",
    jobs: [{ company: "John Keells Holdings", from: 2018, to: 2022 }, { company: "Hayleys PLC", from: 2022 }],
    schools: ["University of Moratuwa"],
  };
  eq(
    "initials, and the same company from the same year: certain",
    samePerson({ name: "K. Perera", jobs: [{ company: "John Keells Holdings PLC", from: 2018, to: 2022 }] }, cvHeld).strength,
    "same",
  );
  eq(
    "…the same company in other years is only possible",
    samePerson({ name: "K. Perera", jobs: [{ company: "John Keells Holdings", from: 2010, to: 2012 }] }, cvHeld).strength,
    "possible",
  );
  const near = samePerson({ name: "Kasun Perera", company: "Commercial Bank of Ceylon", schools: ["Moratuwa University"] }, { ...cvHeld, currentEmployer: "Bank of Ceylon", jobs: [] });
  eq("the same name, a company inside another's, and the same university: certain", near.strength, "same");
  eq("…and says why", near.reasons.includes("Both studied at Moratuwa University"), true);
  eq("the same name and university alone: only possible", samePerson({ name: "Kasun Perera", schools: ["University of Moratuwa"] }, { ...cvHeld, jobs: [], currentEmployer: null }).strength, "possible");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
