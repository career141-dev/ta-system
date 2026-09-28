/**
 * Age and experience from a CV (convex/lib/candidateAge, convex/lib/experience).
 * Each case here is a way the old figures went wrong, or a way a CV writes it.
 */
import { ageOn, birthFromNic, findBirth, parseDayFirst } from "../convex/lib/candidateAge";
import { experienceCheck, experienceOn, parseCvDate, statedExperience } from "../convex/lib/experience";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const on = (s: string) => new Date(`${s}T12:00:00Z`);

console.log("\nage: the dates a CV writes");
eq("12/03/1990 is 12 March, day first", parseDayFirst("12/03/1990"), { y: 1990, m: 3, d: 12 });
eq("03/25/1990 can only be month first", parseDayFirst("03/25/1990"), { y: 1990, m: 3, d: 25 });
eq("1990-03-12", parseDayFirst("1990-03-12"), { y: 1990, m: 3, d: 12 });
eq("12th of March 1990", parseDayFirst("12th of March 1990"), { y: 1990, m: 3, d: 12 });
eq("March 12, 1990", parseDayFirst("March 12, 1990"), { y: 1990, m: 3, d: 12 });
eq("31/02/1990 is not a date", parseDayFirst("31/02/1990"), null);

console.log("\nage: a Sri Lankan NIC carries the birth date");
eq("old NIC, a man: 901234567V is day 123, 2 May 1990", birthFromNic("901234567V"), { y: 1990, m: 5, d: 2 });
eq("old NIC, a woman: day plus 500", birthFromNic("906234567V"), { y: 1990, m: 5, d: 2 });
eq("new NIC: 199012345678", birthFromNic("199012345678"), { y: 1990, m: 5, d: 2 });
eq("day 60 is always 29 February on an NIC — a leap year", birthFromNic("200006012345"), { y: 2000, m: 2, d: 29 });
eq("day 61 is 1 March, whatever the year", birthFromNic("910611234V"), { y: 1991, m: 3, d: 1 });
eq("day 400 is not a date", birthFromNic("904001234V"), null);

console.log("\nage: counted on the day it is shown");
eq("the day before the birthday", ageOn("1990-03-12", on("2026-03-11")), 35);
eq("on the birthday", ageOn("1990-03-12", on("2026-03-12")), 36);

console.log("\nage: read from a whole CV");
eq("a labelled date of birth", findBirth("Name: Nimal\nDate of Birth : 12/03/1990\nNationality: Sri Lankan"), { date: "1990-03-12", source: "dob", precision: "exact" });
eq("D.O.B. written short", findBirth("D.O.B - 1990-03-12"), { date: "1990-03-12", source: "dob", precision: "exact" });
eq("the NIC alone", findBirth("NIC No: 901234567V\nMobile: 0771234567"), { date: "1990-05-02", source: "nic", precision: "exact" });
eq("the date and the NIC agree", findBirth("DOB: 02/05/1990 NIC 901234567V"), { date: "1990-05-02", source: "dob", precision: "exact" });
eq(
  "they disagree: the NIC is kept, and the difference said",
  findBirth("DOB: 04/05/1990\nNIC: 901234567V"),
  { date: "1990-05-02", source: "nic", precision: "exact", mismatch: "CV says 1990-05-04, NIC says 1990-05-02" },
);
eq("a stated age, from the day the CV came in", findBirth("Age: 34 years", on("2024-01-10")), { date: "1990-07-01", source: "stated_age", precision: "year" });
eq("a phone number is not an age", findBirth("Page 2 of 3\nTel: 0112345678"), null);
eq("a birth date that would make them 5 is ignored", findBirth("Date of birth: 01/01/2021"), null);

console.log("\nexperience: the dates a CV writes");
eq("Jan 2019", parseCvDate("Jan 2019"), { y: 2019, m: 1 });
eq("Mar'19", parseCvDate("Mar'19"), { y: 2019, m: 3 });
eq("03/2019", parseCvDate("03/2019"), { y: 2019, m: 3 });
eq("01/03/2019 is March, day first", parseCvDate("01/03/2019"), { y: 2019, m: 3 });
eq("2019-03", parseCvDate("2019-03"), { y: 2019, m: 3 });
eq("a year alone", parseCvDate("2019"), { y: 2019, m: null });
eq("Till date", parseCvDate("Till date"), { y: 0, m: null, present: true });
eq("nonsense", parseCvDate("some time ago"), null);

console.log("\nexperience: the sum");
{
  const today = on("2026-09-28");
  const r = experienceOn([{ startDate: "Jan 2020", endDate: "Present" }], today);
  eq("a current job counts to today, not to the day the CV was read", [r?.years, r?.current], [6.7, true]);
  eq("the same job, a year later, is a year more", experienceOn([{ startDate: "Jan 2020", endDate: "Present" }], on("2027-09-28"))?.years, 7.7);
  eq("2019 – 2019 is a year's work, not nothing", experienceOn([{ startDate: "2019", endDate: "2019" }], today)?.years, 1);
  eq("2019 – 2021, years alone, is three years and marked approximate", [experienceOn([{ startDate: "2019", endDate: "2021" }], today)?.years, experienceOn([{ startDate: "2019", endDate: "2021" }], today)?.approximate], [3, true]);
  eq("Mar 2019 – Feb 2021 is two years", experienceOn([{ startDate: "Mar 2019", endDate: "Feb 2021" }], today)?.years, 2);
  eq(
    "two jobs at the same time are counted once",
    experienceOn([{ startDate: "Jan 2018", endDate: "Dec 2020" }, { startDate: "Jun 2019", endDate: "Dec 2021" }], today)?.years,
    4,
  );
  eq("a gap between jobs is not counted", experienceOn([{ startDate: "Jan 2015", endDate: "Dec 2015" }, { startDate: "Jan 2018", endDate: "Dec 2018" }], today)?.years, 2);
  eq("a job with no end date is the current one", experienceOn([{ startDate: "Jan 2025" }], today)?.current, true);
  const school = experienceOn([{ startDate: "2004", endDate: "2008" }, { startDate: "Jan 2015", endDate: "Dec 2015" }], today, 1995);
  eq("a 'job' at 9 is left out once the birth year is known", [school?.years, school?.skipped], [1, 1]);
  eq("a start in the future is left out", experienceOn([{ startDate: "Jan 2091", endDate: "Present" }], today), null);
  eq("dates it cannot read give no figure, not zero", experienceOn([{ startDate: "long ago", endDate: "recently" }], today), null);
}

console.log("\nexperience: checked against what the CV claims");
eq("'10+ years of experience'", statedExperience("A logistics professional with 10+ years of experience in sea freight."), 10);
eq("'8 years of hands-on experience'", statedExperience("8 years of hands-on experience"), 8);
eq("no claim", statedExperience("Worked at SWEN since 2019."), null);
eq("close enough is not a flag", experienceCheck({ years: 9.2, current: true, approximate: false, counted: 3, skipped: 0 }, 10), null);
eq(
  "far out is said, so the TA knows which to question",
  experienceCheck({ years: 4.1, current: true, approximate: false, counted: 2, skipped: 0 }, 10),
  "CV says 10 years; its job dates add up to 4.1",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
