import { keepHit, parseBooleanQuery, searchMatrix, toNaturalSearch } from "@/lib/websearch";
import { searchProvider, searxngEngines, searxngHits, searxngInstances, searxngRefusals, searxngSlot, type SearchHit } from "@/lib/serper";

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


console.log("\nSearXNG: what an instance answered, as hits");
{
  const body = {
    results: [
      { url: "https://lk.linkedin.com/in/sahan-g", title: "Sahan G — CFO", content: "Chief Financial Officer at Hayleys" },
      { url: "https://lk.linkedin.com/in/sahan-g", title: "Sahan G", content: "duplicate" },
      { url: "https://www.topjobs.lk/jobs/cfo", title: "CFO vacancy", content: "Apply now" },
      { url: "not-an-address", title: "junk", content: "" },
      { url: "https://www.linkedin.com/in/nimal-p", title: "Nimal P — CFO", content: "" },
    ],
  };
  const hits = searxngHits(body, `site:linkedin.com/in "CFO" -inurl:jobs`, 10);
  eq("the site operator is enforced on our side", hits.map((h) => h.url), ["https://lk.linkedin.com/in/sahan-g", "https://www.linkedin.com/in/nimal-p"]);
  eq("content is the snippet", hits[0].snippet, "Chief Financial Officer at Hayleys");
  eq("only as many as were asked for", searxngHits(body, "cfo", 1).length, 1);
  eq("nothing at all is no hits, not a crash", searxngHits({}, "cfo", 10), []);
}

console.log("\nwho answers a search");
{
  const env = { ...process.env };
  const set = (v: Record<string, string | undefined>) => {
    for (const k of ["SEARXNG_URL", "SERPER_API_KEY", "C141_SEARCH_PROVIDER", "OPENAI_API_KEY"]) delete process.env[k];
    Object.assign(process.env, v);
  };
  set({ SEARXNG_URL: "https://searx.example/ , https://other.example", SERPER_API_KEY: "k" });
  eq("an instance is named, so SearXNG answers and Serper does not", searchProvider(), "searxng");
  eq("the instances, trimmed and in order", searxngInstances(), ["https://searx.example", "https://other.example"]);
  set({ SERPER_API_KEY: "k" });
  eq("no instance: Serper still answers", searchProvider(), "serper");
  set({ SEARXNG_URL: "not a url" });
  eq("an address that is not one is no instance", searchProvider(), null);
  set({ SEARXNG_URL: "https://searx.example", C141_SEARCH_PROVIDER: "serper", SERPER_API_KEY: "k" });
  eq("naming Serper still gets Serper", searchProvider(), "serper");
  process.env = env;
}

console.log("\nSearXNG: which engines, and what they said");
{
  const env = process.env.SEARXNG_ENGINES;
  delete process.env.SEARXNG_ENGINES;
  eq("Google, Bing and Yahoo unless we are told otherwise", searxngEngines(), "google,bing,yahoo");
  process.env.SEARXNG_ENGINES = " mojeek,google ";
  eq("and whatever we are told, as given", searxngEngines(), "mojeek,google");
  if (env === undefined) delete process.env.SEARXNG_ENGINES; else process.env.SEARXNG_ENGINES = env;
  eq("a refusal names the engine and the reason", searxngRefusals([["brave", "too many requests"], ["qwant", "CAPTCHA"]]), "brave: too many requests, qwant: CAPTCHA");
  eq("nothing refused is nothing to say", searxngRefusals(undefined), "");
}

console.log("\nSearXNG: asked at a pace Google tolerates");
{
  // Eighteen at once is what Research reaches, and it is what made Google send
  // a CAPTCHA on the server (23 Sep). They queue instead.
  let running = 0;
  let mostAtOnce = 0;
  const started: number[] = [];
  const one = () =>
    searxngSlot(async () => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      started.push(Date.now());
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return 1;
    }, 2, 20);
  const began = Date.now();
  const all = await Promise.all(Array.from({ length: 18 }, one));
  eq("every search still runs", all.length, 18);
  eq("never more than two at a time", mostAtOnce <= 2, true);
  eq("and they are spaced out, not fired together", Date.now() - began >= 17 * 20, true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
