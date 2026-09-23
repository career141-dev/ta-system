import { keepHit, parseBooleanQuery, searchMatrix, toNaturalSearch } from "@/lib/websearch";
import type { SearchHit } from "@/lib/serper";

let passed = 0;
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${g}, want ${w}`); }
};

console.log("a Google Boolean string, taken apart");
{
  const q = parseBooleanQuery(`site:linkedin.com/in "Hayleys PLC" ("CFO" OR "Chief Financial Officer") -inurl:jobs -inurl:dir -warehouse`);
  eq("the site operator is lifted out", q.sites, ["linkedin.com/in"]);
  eq("the inurl negatives are lifted out", q.notInUrl, ["jobs", "dir"]);
  eq("a plain negative term too", q.notTerms, ["warehouse"]);
  eq("the phrases survive", q.phrases, ["Hayleys PLC", "CFO", "Chief Financial Officer"]);
  eq("no operator is left in the search itself", /site:|inurl:|[()]/.test(q.text), false);
  eq("what is searched for", q.text, `"Hayleys PLC" "CFO" OR "Chief Financial Officer"`);
  eq("and how it is put to the tool", toNaturalSearch(q), `"Hayleys PLC" "CFO" OR "Chief Financial Officer" on linkedin.com/in`);
}
{
  const q = parseBooleanQuery(`"Aitken Spence" Conglomerate`);
  eq("a query with no operators is left alone", [q.text, q.sites, q.notInUrl], [`"Aitken Spence" Conglomerate`, [], []]);
}

console.log("\nthe operators the tool was never given, applied to what it returned");
const hit = (url: string, title = "", snippet = ""): SearchHit => ({ url, title, snippet });
{
  const q = parseBooleanQuery(`site:linkedin.com/in "CFO" -inurl:jobs -intern`);
  eq("a profile is kept", keepHit(hit("https://www.linkedin.com/in/ruwan-perera"), q), true);
  eq("a country subdomain is the same site", keepHit(hit("https://lk.linkedin.com/in/ruwan-perera"), q), true);
  eq("a company page is not under /in", keepHit(hit("https://www.linkedin.com/company/hayleys"), q), false);
  eq("another site is not this site", keepHit(hit("https://rocketreach.co/ruwan-perera"), q), false);
  eq("-inurl:jobs throws out the job board", keepHit(hit("https://www.linkedin.com/in/jobs-bot"), q), false);
  eq("a negative term in the snippet throws it out", keepHit(hit("https://www.linkedin.com/in/x", "X", "Finance intern"), q), false);
  eq("something that is not an address is never a result", keepHit(hit("linkedin.com/in/x"), q), false);
}
{
  const q = parseBooleanQuery(`"Hayleys" leadership`);
  eq("no site operator, anywhere is fine", keepHit(hit("https://www.hayleys.com/leadership"), q), true);
}

console.log("\nseveral angles at once");
{
  const seen: string[] = [];
  const web = async (q: string) => {
    seen.push(q);
    if (q === "angle one") return { hits: [hit("https://a.com/x", "A", "short"), hit("https://b.com/y", "B", "")], credits: 1 };
    if (q === "angle two") return { hits: [hit("https://a.com/x/", "", "a much longer description of A")], credits: 1 };
    return { hits: [], credits: 0, error: "429" };
  };
  const r = await searchMatrix(["angle one", "angle two", "angle three"], web);
  eq("every angle is fired", seen.length, 3);
  eq("the same page found twice is one result", r.hits.length, 2);
  eq("counted, and first", [r.hits[0].url, r.hits[0].hitCount], ["https://a.com/x", 2]);
  eq("it remembers which angles found it", r.hits[0].matchedQueries, ["angle one", "angle two"]);
  eq("the fullest description wins", r.hits[0].snippet, "a much longer description of A");
  eq("a failed angle is reported, not swallowed", r.errors, ["429"]);
  eq("credits are added up", r.credits, 2);
}
{
  // Benchmark dedupes people, not addresses: one person behind two hosts.
  const web = async (q: string) => ({
    hits: q === "one"
      ? [hit("https://lk.linkedin.com/in/ruwan-perera")]
      : [hit("https://www.linkedin.com/in/Ruwan-Perera")],
    credits: 1,
  });
  const key = (u: string) => u.toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] ?? null;
  const r = await searchMatrix(["one", "two"], web, { key });
  eq("lk. and www. are the same person", [r.hits.length, r.hits[0].hitCount], [1, 2]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
