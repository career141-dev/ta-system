/**
 * Names for the Referral Search (29 Oct): a pasted list is read as names, and a
 * typed name is graded against the one on file. Synthetic names only.
 */
import { looksLikeName, nameList, nameMatch, nameWords, splitNameList } from "@/lib/nameMatch";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe words of a name");
eq("lower-case, dots and accents gone", nameWords("Dr. José O'Neil-Perera"), ["jose", "oneil", "perera"]);
eq("an honorific is not a word", nameWords("Mr Nimal Perera"), ["nimal", "perera"]);
eq("a one-word name keeps its word", nameWords("Dr"), ["dr"]);

console.log("\nsplitting a pasted list");
eq("lines", splitNameList("Nimal Perera\nSunil Silva\n"), ["Nimal Perera", "Sunil Silva"]);
eq("commas, semicolons and bars", splitNameList("Nimal Perera, Sunil Silva; Kamal Fernando | Amal Jayasuriya"), ["Nimal Perera", "Sunil Silva", "Kamal Fernando", "Amal Jayasuriya"]);
eq("numbering and bullets", splitNameList("1. Nimal Perera\n2) Sunil Silva\n- Kamal Fernando\n• Amal Jayasuriya"), ["Nimal Perera", "Sunil Silva", "Kamal Fernando", "Amal Jayasuriya"]);
eq("the same name twice, in another order, once", splitNameList("Nimal Perera\nPerera Nimal\nMr Nimal Perera"), ["Nimal Perera"]);
eq("blank lines and tabs", splitNameList("\n\nNimal Perera\t\n\n"), ["Nimal Perera"]);
eq("a hundred at most", splitNameList(Array.from({ length: 150 }, (_, i) => `Aa${"b".repeat(i % 7)} Cc${"d".repeat(Math.floor(i / 7))}`).join("\n")).length, 100);

console.log("\nnames or a question");
eq("two words is a name", looksLikeName("Nimal Perera"), true);
eq("initials are fine", looksLikeName("N. K. Perera"), true);
eq("one word is not", looksLikeName("Nimal"), false);
eq("a title is not a name", looksLikeName("HR Managers"), false);
eq("a sentence is not a name", looksLikeName("Finance Directors at Hemas"), false);
eq("digits are not a name", looksLikeName("Nimal 2024"), false);
eq("a list of names", nameList("Nimal Perera\nSunil Silva"), ["Nimal Perera", "Sunil Silva"]);
eq("one non-name spoils the list", nameList("Nimal Perera\nHR Managers at Dialog"), null);
eq("a question is not a list", nameList("HR Managers at Dialog, Finance Directors at Hemas"), null);
eq("nothing is not a list", nameList("   \n "), null);

console.log("\nthe same person?");
eq("same words", nameMatch("Nimal Perera", "Nimal Perera"), "same");
eq("another case", nameMatch("nimal perera", "NIMAL PERERA"), "same");
eq("another order", nameMatch("Perera Nimal", "Nimal Perera"), "same");
eq("an honorific", nameMatch("Mr Nimal Perera", "Nimal Perera"), "same");
eq("a middle name on file", nameMatch("Nimal Perera", "Nimal Kumar Perera"), "likely");
eq("a middle name typed", nameMatch("Nimal Kumar Perera", "Nimal Perera"), "likely");
eq("an initial typed", nameMatch("N. Perera", "Nimal Perera"), "likely");
eq("an initial on file", nameMatch("Nimal Perera", "N Perera"), "likely");
eq("a one-letter surname typo", nameMatch("Nimal Pereira", "Nimal Perera"), "maybe");
eq("a one-letter first-name typo", nameMatch("Nimali Perera", "Nimal Perera"), "maybe");
eq("only the first name is shared", nameMatch("Nimal Silva", "Nimal Perera"), null);
eq("only the surname is shared", nameMatch("Sunil Perera", "Nimal Perera"), null);
eq("two letters apart is someone else", nameMatch("Nimal Perrara", "Nimal Perera"), null);
eq("a single word never matches", nameMatch("Nimal", "Nimal Perera"), null);
eq("short words are not fuzzy", nameMatch("Ann Lee", "Ana Lee"), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
