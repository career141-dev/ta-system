/** The notice period a TA types on Review details (lib/answered), as days. */
import { noticePeriodToDays } from "@/lib/answered";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

eq("30 days", noticePeriodToDays("30 days"), 30);
eq("a bare number is days", noticePeriodToDays("45"), 45);
eq("2 weeks", noticePeriodToDays("2 weeks"), 14);
eq("2 months", noticePeriodToDays("2 months"), 60);
eq("1 month", noticePeriodToDays("1 month"), 30);
eq("Immediate", noticePeriodToDays("Immediate"), 0);
eq("available now", noticePeriodToDays("available now"), 0);
eq("negotiable is not a number of days", noticePeriodToDays("negotiable"), null);
eq("empty", noticePeriodToDays(""), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
