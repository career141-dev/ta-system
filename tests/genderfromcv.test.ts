import { genderFromLabel, genderFromNic, nicGender, normaliseGender, resolveGender } from "../convex/cvs/genderFromCv";

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe CV states it");
eq("Gender: Male", genderFromLabel("Name: Kamal\nGender: Male\nNationality: Sri Lankan"), "Male");
eq("Sex : F", genderFromLabel("Sex : F"), "Female");
eq("GENDER - Female", genderFromLabel("GENDER - Female"), "Female");
eq("Gender/Sex Male", genderFromLabel("Gender/Sex Male"), "Male");
eq("value on the next line", genderFromLabel("Gender\nFemale\nReligion\nBuddhism"), "Female");
eq("two-column line", genderFromLabel("Gender: Male Marital status: Married"), "Male");
eq("sample CV from the de-identification tests", genderFromLabel("DOB : 12/04/1985\nPassport No. N1234567\nGender: Male Marital status: Married"), "Male");
eq("'Gender Marital' is not an M", genderFromLabel("Gender Marital status single"), null);
eq("'M.Sc' after the label is not an M", genderFromLabel("Gender\nM.Sc in Finance"), null);
eq("'Sex: M.' is an M", genderFromLabel("Sex: M.\nAge: 30"), "Male");
eq("'gender equality' is not a reading", genderFromLabel("Led the gender equality committee"), null);
eq("Essex is not a label", genderFromLabel("Lived in Essex, F block"), null);
eq("two labels that disagree", genderFromLabel("Gender: Male\nSex: Female"), null);

console.log("\nthe NIC number");
eq("old NIC, day 345 → Male", nicGender("853456789V"), "Male");
eq("old NIC, day 845 → Female", nicGender("858456789V"), "Female");
eq("new NIC, day 845 → Female", nicGender("198584567890"), "Female");
eq("new NIC, day 34 → Male", nicGender("199003412345"), "Male");
eq("day 0 is not a date", nicGender("850006789V"), null);
eq("day 400 is not a date", nicGender("854006789V"), null);
eq("day 900 is not a date", nicGender("859006789V"), null);
eq("labelled NIC in a CV", genderFromNic("NIC No: 858456789V\nMobile: 0771234567"), "Female");
eq("N.I.C with the number on the next line", genderFromNic("N.I.C\n853456789V"), "Male");
eq("National Identity Card Number", genderFromNic("National Identity Card Number : 198584567890"), "Female");
eq("no label → not read", genderFromNic("Account 198584567890 at BOC"), null);
eq("two NICs that disagree", genderFromNic("NIC: 853456789V\nNIC: 858456789V"), null);

console.log("\nwhat the model read");
eq("'female ' trimmed", normaliseGender("female "), "Female");
eq("'unknown' is nothing", normaliseGender("unknown"), null);
eq("null is nothing", normaliseGender(null), null);

console.log("\norder: stated, then NIC, then the model");
eq("stated beats the NIC", resolveGender({ rawText: "Gender: Male\nNIC: 858456789V", llmGender: "Female" }), { gender: "Male", source: "cv_stated" });
eq("NIC beats the model", resolveGender({ rawText: "NIC: 858456789V", llmGender: "Male" }), { gender: "Female", source: "nic" });
eq("the model when nothing else", resolveGender({ rawText: "Mr. Kamal Perera, accountant", llmGender: "male" }), { gender: "Male", source: "cv_llm" });
eq("nothing → blank", resolveGender({ rawText: "Kamal Perera, accountant", llmGender: null }), null);
eq("no text at all", resolveGender({ rawText: undefined, llmGender: undefined }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
