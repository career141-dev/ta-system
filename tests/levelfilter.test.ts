/**
 * The level filter on Database search (src/lib/levels): the levels a list holds,
 * counted, nearest the job's level first, and what ticking one does.
 */
import { inSelectedLevels, levelKey, levelOptions } from "@/lib/levels";
import type { Candidate, Opening } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const person = (id: string, currentTitle: string | null, years: number | null = 5, currentLevel?: number | null) =>
  ({ id, currentTitle, totalExperienceYears: years, currentLevel }) as unknown as Candidate;
const job = (title: string) => ({ id: "o1", title, requirements: {} }) as unknown as Opening;

// A search for a Senior Software Engineer that matched people at several levels.
const people = [
  person("a", "Senior Software Engineer"),
  person("b", "Senior Software Engineer"),
  person("c", "Software Engineer"),
  person("d", "Software Engineer"),
  person("e", "Software Engineer"),
  person("f", "Associate Software Engineer"),
  person("g", "Junior Software Engineer"),
  person("h", "Software Engineering Manager"),
  person("i", null, null),
];

console.log("\nThe levels a search for a Senior Software Engineer holds");
{
  const o = levelOptions(job("Senior Software Engineer"), people);
  eq("each level once, nearest the job's level first, unknown last", o.map((x) => x.name), [
    "Senior", "Mid-level", "Junior / Associate", "Manager", "Level not known",
  ]);
  eq("how many people at each", o.map((x) => x.count), [2, 3, 2, 1, 1]);
  eq("how each sits against the job", o.map((x) => x.note), [
    "this job's level", "one level below", "two levels below", "above this job's level", null,
  ]);
  eq("the keys are what the URL carries", o.map((x) => x.key), ["3", "2", "1", "5", "x"]);
}

console.log("\nWithout a job: every level, highest first");
{
  const o = levelOptions(null, people);
  eq("highest level first", o.map((x) => x.name), ["Manager", "Senior", "Mid-level", "Junior / Associate", "Level not known"]);
  eq("no note without a job", o.every((x) => x.note === null), true);
}

console.log("\nThe engine's own level wins over the title");
{
  const p = person("z", "Software Engineer", 5, 3);
  eq("currentLevel 3 is Senior whatever the title says", levelKey(p), "3");
  eq("no level and no title is unknown", levelKey(person("y", null, null)), "x");
}

console.log("\nTicking a level");
{
  const pick = (...k: string[]) => people.filter((c) => inSelectedLevels(c, new Set(k))).map((c) => c.id);
  eq("nothing ticked shows everyone", pick(), ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  eq("one level", pick("2"), ["c", "d", "e"]);
  eq("two levels together", pick("3", "1"), ["a", "b", "f", "g"]);
  eq("the unknown level", pick("x"), ["i"]);
  eq("a level nobody is at shows nobody", pick("9"), []);
}

console.log("\nOne level or none: nothing to choose");
eq("a single level still lists (the page hides it)", levelOptions(job("Senior Software Engineer"), [people[0], people[1]]).length, 1);
eq("an empty list lists nothing", levelOptions(null, []).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
