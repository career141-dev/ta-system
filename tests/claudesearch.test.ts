/**
 * Claude's web search (src/lib/claudeSub parseClaudeSearch) and the search
 * benchmark (src/lib/searchBench). The rule under test: an address is kept only
 * when Claude's search tool returned it — never because Claude's reply named it.
 */
import { parseClaudeSearch } from "@/lib/claudeSub";
import { benchmarkSearch } from "@/lib/searchBench";
import type { SearchResult } from "@/lib/serper";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const stream = (toolText: string, final: string, extra: Record<string, unknown> = {}) =>
  [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "q" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: toolText }] }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: final, ...extra }),
  ].join("\n");

const LINKS = `Web search results for query: "Hayleys PLC"\n\nLinks: [{"title":"Hayleys PLC","url":"https://www.hayleys.com/"},{"title":"Hayleys | LinkedIn","url":"https://lk.linkedin.com/company/hayleys-plc"},{"title":"Hayleys - Wikipedia","url":"https://en.wikipedia.org/wiki/Hayleys"}]\n\nSummary text.`;

console.log("\nClaude's search: only addresses its search returned");
{
  const r = parseClaudeSearch(
    stream(LINKS, 'Here you go:\n```json\n[{"url":"https://www.hayleys.com/","snippet":"Diversified group, Colombo."},{"url":"https://hayleys-careers.example/jobs","snippet":"made up"}]\n```'),
    `"Hayleys PLC"`,
    10,
  );
  eq("the three results the search returned, in its order", r.hits.map((h) => h.url), ["https://www.hayleys.com/", "https://lk.linkedin.com/company/hayleys-plc", "https://en.wikipedia.org/wiki/Hayleys"]);
  eq("titles come from the search", r.hits[0].title, "Hayleys PLC");
  eq("Claude's line becomes the snippet", r.hits[0].snippet, "Diversified group, Colombo.");
  eq("an address only Claude's reply named is dropped, and counted", [r.hits.some((h) => h.url.includes("example")), r.ungrounded], [false, 1]);
  eq("no error, one search", [r.error, r.credits], [undefined, 1]);
}
{
  const r = parseClaudeSearch(stream(LINKS, "[]"), `"Hayleys PLC" site:linkedin.com/company`, 10);
  eq("site: is enforced on Claude's results too", r.hits.map((h) => h.url), ["https://lk.linkedin.com/company/hayleys-plc"]);
}
{
  const r = parseClaudeSearch(stream(LINKS, "[]"), "hayleys", 2);
  eq("no more than were asked for", r.hits.length, 2);
}

console.log("\nwhen Claude's search does not work");
{
  const r = parseClaudeSearch(stream("", "Claude AI usage limit reached", { is_error: true, subtype: "error_during_execution" }), "q", 10);
  eq("a usage limit is an error, so SearXNG answers", [r.hits.length, Boolean(r.error)], [0, true]);
}
{
  const r = parseClaudeSearch(stream("Web search results for query: \"q\"\n\nNo links found.", "[]"), "q", 10);
  eq("a search that found nothing is empty, not failed", [r.hits.length, r.error], [0, undefined]);
}
{
  const r = parseClaudeSearch('{"type":"system"}\n{"type":"assist', "q", 10);
  eq("a run cut off before it answered is an error", Boolean(r.error), true);
}
{
  const text = 'Results:\n{"title": "Acme", "url": "https://acme.lk/"}, {"title": "Beta", "url": "https://beta.lk/about"}';
  const r = parseClaudeSearch(stream(text, "[]"), "acme", 10);
  eq("links read from a looser format", r.hits.map((h) => h.url), ["https://acme.lk/", "https://beta.lk/about"]);
}

console.log("\nthe benchmark");
{
  const hit = (url: string) => ({ url, title: url, snippet: "" });
  const claude = async (q: string): Promise<SearchResult> =>
    q.includes("site:linkedin")
      ? { hits: [hit("https://lk.linkedin.com/company/hayleys-plc")], credits: 1, provider: "claude", ungrounded: 1 }
      : { hits: [hit("https://www.hayleys.com/"), hit("https://en.wikipedia.org/wiki/Hayleys")], credits: 1, provider: "claude" };
  const searxng = async (q: string): Promise<SearchResult> =>
    q.includes("jobs") ? { hits: [], credits: 0, error: "google: CAPTCHA" } : { hits: [hit("https://en.wikipedia.org/wiki/Hayleys")], credits: 1 };
  (async () => {
    const r = await benchmarkSearch({ client: "Hayleys PLC", industry: "", where: "Sri Lanka", title: "CFO" }, { claude, searxng });
    eq("six Research queries asked of each", r.queries.length, 6);
    eq("answered counts", [r.summary.claude.answered, r.summary.searxng.answered], ["6/6", "5/6"]);
    eq("the client's own site, as Research would pick it", [r.summary.claude.officialSite, r.summary.searxng.officialSite], ["https://www.hayleys.com", null]);
    eq("the LinkedIn page", r.summary.claude.linkedinPage, "https://www.linkedin.com/company/hayleys-plc");
    eq("ungrounded addresses are summed", r.summary.claude.ungrounded, 1);
    eq("an engine's refusal is listed", r.summary.searxng.errors, ["google: CAPTCHA"]);
    eq("agreement is between 0 and 1", r.agreement > 0 && r.agreement < 1, true);
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })();
}
