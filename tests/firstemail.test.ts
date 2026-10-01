/**
 * The first follow-up email: the desk's approved reach-out (30 September),
 * written as the candidate's TA. Pure — no database, nothing sent.
 */
import { initialReachOutEmail } from "../convex/communications/emailHtml";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe approved email, word for word");
const e = initialReachOutEmail({
  candidateName: "Nimal Perera",
  gender: "Male",
  taName: "Shamra",
  taEmail: "Shamra@Career141.com",
  jobTitle: "COO",
  clientIndustry: "Apparel",
  country: "Sri Lanka",
  asks: ["Current Salary", "Expected Salary", "Notice Period", "Years of experience working with Sweater / Knit products"],
});
eq("the text", e.text, `Dear Mr. Nimal Perera,

I hope you are doing well.

This is Shamra from Career141. With reference to your profile, which we have received for the COO opportunity, this position is with one of the leading apparel clients in Sri Lanka.

Our team will be reaching out to you shortly to brief you further on the opportunity. In the meantime, we would appreciate it if you could kindly share the following details:

- Current Salary
- Expected Salary
- Notice Period
- Years of experience working with Sweater / Knit products

Thank you, and we look forward to hearing from you.

Best regards,
Shamra
Career141
Shamra@Career141.com`);
eq("the subject names the role", e.subject, "COO opportunity – Career141");
eq("the HTML carries the same asks", e.html.includes("• Years of experience working with Sweater / Knit products"), true);

console.log("\nwhat is not known is left out, never guessed");
const bare = initialReachOutEmail({ candidateName: "Kumari Silva", jobTitle: "Brand Manager", asks: ["Notice Period"] });
eq("no gender: no Mr. or Ms.", bare.text.startsWith("Dear Kumari Silva,"), true);
eq("no industry or country: just 'one of the leading clients'", bare.text.includes("with one of the leading clients."), true);
eq("no TA: signed by the team", bare.text.includes("Best regards,\nTalent Acquisition Team\nCareer141"), true);
eq("female: Ms.", initialReachOutEmail({ candidateName: "Kumari Silva", gender: "Female", jobTitle: "X", asks: [] }).text.startsWith("Dear Ms. Kumari Silva,"), true);
eq("no name at all", initialReachOutEmail({ candidateName: null, jobTitle: "X", asks: [] }).text.startsWith("Dear Candidate,"), true);
eq("a name with its own title gets no second one", initialReachOutEmail({ candidateName: "Mr. Nimal Perera", gender: "Male", jobTitle: "X", asks: [] }).text.startsWith("Dear Mr. Nimal Perera,"), true);
eq("…nor 'Dr.' a 'Ms.'", initialReachOutEmail({ candidateName: "Dr. Kumari Silva", gender: "Female", jobTitle: "X", asks: [] }).text.startsWith("Dear Dr. Kumari Silva,"), true);
eq("a name starting like a title is still titled", initialReachOutEmail({ candidateName: "Drashan Silva", gender: "Male", jobTitle: "X", asks: [] }).text.startsWith("Dear Mr. Drashan Silva,"), true);
eq("a name is escaped in the HTML", initialReachOutEmail({ candidateName: "<b>x</b>", jobTitle: "X", asks: [] }).html.includes("<b>x</b>"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
