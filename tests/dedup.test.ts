import { phoneKey, emailKey, linkedinKey, nameSimilarity, compare, planMerge } from "@/lib/dedup";

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nphone — the four ways the desk writes one number");
for (const p of ["0771234567", "+94 77 123 4567", "94771234567", "077-123 4567", "0094771234567", "77 123 4567"])
  eq(JSON.stringify(p), phoneKey(p), "94771234567");
eq("foreign kept as-is", phoneKey("+8801712345678"), "8801712345678");
eq("extension rejected", phoneKey("ext 4412"), null);

console.log("\nemail");
eq("case + space", emailKey("  Nimal.Perera@Gmail.COM "), "nimalperera@gmail.com");
eq("gmail +tag", emailKey("nimal.perera+jobs@gmail.com"), "nimalperera@gmail.com");
eq("googlemail folds", emailKey("nimalperera@googlemail.com"), "nimalperera@gmail.com");
eq("non-gmail dots kept", emailKey("hr.desk@brandix.com"), "hr.desk@brandix.com");
eq("non-gmail +tag kept", emailKey("accounts+hr@mas.lk"), "accounts+hr@mas.lk");

console.log("\nlinkedin");
eq("query + www + slash", linkedinKey("https://www.linkedin.com/in/nimal-perera-123/?utm_source=share"), "nimal-perera-123");
eq("country host", linkedinKey("https://lk.linkedin.com/in/nimal-perera-123"), "nimal-perera-123");

console.log("\nnames");
eq("initials vs expansion", nameSimilarity("W.A.D.S. Perera", "Wijesinghe Arachchige Don Sunil Perera") >= 0.72, true);
eq("same person, middle dropped", nameSimilarity("Nimal Perera", "Nimal Chandana Perera") >= 0.72, true);
eq("initial only, diff surname", nameSimilarity("S. Perera", "S. Peiris") < 0.72, true);
eq("two strangers", nameSimilarity("Nimal Perera", "Kasun Silva") < 0.4, true);
eq("typo", nameSimilarity("Gihan Nanayakkara", "Gihan Nanayakara") >= 0.72, true);

console.log("\nverdicts");
const base = { fullName: "Nimal Perera", email: "nimal.perera@gmail.com", phone: "0771234567", currentEmployer: "Brandix Apparel Ltd" };
eq("reformatted phone, same person → same",
  compare({ fullName: "N. Perera", phone: "+94 77 123 4567" }, base).verdict, "same");
eq("shared household phone → review",
  compare({ fullName: "Kasun Silva", phone: "0771234567" }, base).verdict, "review");
eq("same name, no keys, same employer → review",
  compare({ fullName: "Nimal Perera", currentEmployer: "Brandix (Pvt) Ltd", email: "nimal@yahoo.com" }, base).verdict, "review");
eq("same name, nothing else → new",
  compare({ fullName: "Nimal Perera" }, base).verdict, "new");
eq("stranger → new", compare({ fullName: "Kasun Silva", email: "kasun@x.lk" }, base).verdict, "new");
eq("identical file beats a name clash",
  compare({ fullName: "Scan 0012", fileHash: "abc" }, { ...base, fileHash: "abc" }).verdict, "same");

console.log("\nmerge never overwrites");
const plan = planMerge(
  { fullName: "Nimal Perera", email: "old@gmail.com", phone: null as string | null, skills: ["Excel", "SAP"] },
  { email: "new@gmail.com", phone: "0771234567", skills: ["SAP", "Power BI"] },
  ["fullName", "email", "phone", "skills"],
);
eq("blank filled", plan.fill.phone, "0771234567");
eq("list grew", plan.fill.skills, ["Excel", "SAP", "Power BI"]);
eq("held value not overwritten", plan.fill.email, undefined);
eq("held value raised as conflict", plan.conflicts.map(c => c.field), ["email"]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
