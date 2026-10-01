import { refereeWindow, REFEREE_MAX_CHARS, REFEREE_SECTION_CHARS } from "../convex/cvs/refereeWindow";

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// A page of CV text is roughly 3,000–4,000 characters.
const page = (n: number) => `Worked at Company ${n} as an accountant, handling ledgers and audits. `.repeat(50);
const referees = "REFERENCES\nMr. Nimal Perera\nFinance Manager, Brandix\n077 123 4567\n\nMs. Anoma Silva\nAudit Lead, KPMG\n071 765 4321";

console.log("\nsix-page CV — read whole, referees included");
const six = [1, 2, 3, 4, 5, 6].map(page).join("\n") + "\n" + referees;
eq("longer than the main read's 6,000", six.length > 6000, true);
eq("fits the referee read", six.length <= REFEREE_MAX_CHARS, true);
eq("sent whole", refereeWindow(six), six);
eq("last referee's number reaches the model", refereeWindow(six).includes("071 765 4321"), true);

console.log("\nvery long CV — the referees section from its heading");
const long = Array.from({ length: 16 }, (_, i) => page(i)).join("\n") + "\nReferees:\n" + referees.split("\n").slice(1).join("\n") + "\n" + page(99);
eq("longer than the referee read", long.length > REFEREE_MAX_CHARS, true);
const w = refereeWindow(long);
eq("starts at the heading", w.startsWith("Referees:"), true);
eq("keeps both referees", w.includes("Nimal Perera") && w.includes("Anoma Silva"), true);
eq("bounded", w.length <= REFEREE_SECTION_CHARS, true);

console.log("\nheading variants");
for (const h of ["REFERENCES", "Referees", "Non-Related Referees", "Professional References:", "  Referee  "]) {
  const t = page(0).repeat(12) + `\n${h}\nMr. Kamal Fernando 0771112223\n` + page(1);
  eq(JSON.stringify(h), refereeWindow(t).includes("Kamal Fernando"), true);
}

console.log("\nno heading — the end of the CV");
const bare = page(0).repeat(12) + "\nMr. Kamal Fernando, Director, 0771112223";
eq("tail kept", refereeWindow(bare).endsWith("0771112223"), true);
eq("tail bounded", refereeWindow(bare).length, REFEREE_SECTION_CHARS);

console.log("\n\"References\" in running text is not a heading");
const prose = page(0).repeat(12) + "\nREFEREES\nMr. Kamal Fernando\n" + page(1) + "\nReferences to IFRS standards were made in audits.\n" + page(2);
eq("uses the real heading", refereeWindow(prose).startsWith("REFEREES"), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
