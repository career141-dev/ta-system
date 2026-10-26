/**
 * Rows copied out of a TA's LinkedIn sheet (src/lib/linkPaste.ts, 26 Oct).
 * Layouts are the ones in the TAs' sheets; the people are made up.
 */
import { parseLinkPaste } from "../src/lib/linkPaste";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\nthe sheets' layouts");
const a = parseLinkPaste("1\tAcme\thttps://www.linkedin.com/in/jane-doe-1\tManager - Procurement\t94771234567\tCall back later");
eq("No, company, link, designation, contact, status", a.rows, [{ url: "https://www.linkedin.com/in/jane-doe-1", phone: "94771234567", note: "Acme · Manager - Procurement · Call back later" }]);
const b = parseLinkPaste("https://www.linkedin.com/in/john-roe\tHead of Production | Acme\t+880 1805 558332\tOkay");
eq("link first, a + number with spaces", b.rows[0].phone, "+880 1805 558332");
eq("the rest is the note", b.rows[0].note, "Head of Production | Acme · Okay");

console.log("\nwhat is not a row");
const c = parseLinkPaste("LinkedIn Search\nNo\tCompany\tLinkedIn Profile\tStatus\n\n2\tAcme\thttps://linkedin.com/in/x\t\tConnection request sent");
eq("headings and blank lines are skipped", c.rows.length, 1);
eq("…and counted", c.skipped, 2);
eq("no phone when there is none", c.rows[0].phone, null);
eq("a row number is not a phone", parseLinkPaste("12\thttps://linkedin.com/in/y").rows[0], { url: "https://linkedin.com/in/y", phone: null, note: "" });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
