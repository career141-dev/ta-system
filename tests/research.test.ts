import { parseResearch } from "@/lib/headhunt";
import { webEngine } from "@/lib/ai";
import { groundedCompetitors, parseJsonObject, pickLinkedInCompany, pickOfficialSite, researchViaSearch, type ResearchDeps } from "@/lib/researchSearch";

let passed = 0;
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${g}, want ${w}`); }
};

console.log("research answers, however the model dresses them");
const plain = parseResearch("WEBSITE: https://alghurair.com\nCOUNTRY: UAE\nOVERVIEW: A group.");
eq("plain labels", [plain.websiteLink, plain.country, plain.companyOverview], ["https://alghurair.com", "UAE", "A group."]);

const bold = parseResearch("**WEBSITE:** https://alghurair.com\n**COUNTRY**: UAE\n- SERVICES: Foods; Construction; Energy");
eq("bold labels", [bold.websiteLink, bold.country], ["https://alghurair.com", "UAE"]);
eq("bulleted list label", bold.servicesProvider, ["Foods", "Construction", "Energy"]);

const md = parseResearch("SOCIAL: [LinkedIn](https://www.linkedin.com/company/al-ghurair)\n### OVERVIEW\nFamily-owned.\nFounded 1960.");
eq("markdown link keeps the address", md.socialMedia, "https://www.linkedin.com/company/al-ghurair");
eq("overview as a heading", md.companyOverview, "Family-owned.\nFounded 1960.");

eq("empty stays empty", parseResearch("WEBSITE:\nCOUNTRY:").websiteLink, "");

console.log("\nwhose search the web plugin uses");
eq("deepseek uses exa", webEngine("deepseek/deepseek-v4-flash"), "exa");
eq("openai uses its own", webEngine("openai/gpt-4.1-mini"), "native");

console.log("\nresearch by search: picking the client's own pages");
const hits = (urls: string[]) => urls.map((url) => ({ url, title: url, snippet: "" }));
eq("own site, not a directory", pickOfficialSite(hits(["https://www.linkedin.com/company/hayleys", "https://en.wikipedia.org/wiki/Hayleys", "https://www.hayleys.com/about"]), "Hayleys PLC"), "https://www.hayleys.com");
eq("no site carrying the name is no site", pickOfficialSite(hits(["https://randomblog.net/review"]), "Hayleys PLC"), null);
eq("linkedin company page, canonical", pickLinkedInCompany(hits(["https://lk.linkedin.com/company/hayleys-plc/jobs"]), "Hayleys PLC"), "https://www.linkedin.com/company/hayleys-plc");
eq("someone else's company page is not theirs", pickLinkedInCompany(hits(["https://www.linkedin.com/company/john-keells"]), "Hayleys PLC"), null);

console.log("\ncompetitors must be in what the search returned");
eq(
  "a name the results never mention is dropped, and so is the client",
  groundedCompetitors(["John Keells Holdings", "Made Up Ltd", "Hayleys PLC", "Aitken Spence"], "John Keells Holdings and Aitken Spence lead; Hayleys PLC too", "Hayleys PLC"),
  ["John Keells Holdings", "Aitken Spence"],
);
eq("json in a code fence", parseJsonObject('```json\n{"a": 1}\n```'), { a: 1 });
eq("no json", parseJsonObject("sorry"), null);

console.log("\nresearch by search: a whole run, with the web faked");
{
  const queries: string[] = [];
  const read: string[] = [];
  const reply = (text: string) => ({ ok: true as const, text, sources: [], searches: 0, provider: "fake" });
  const deps: ResearchDeps = {
    search: async (q) => {
      queries.push(q);
      if (q.includes("site:linkedin.com")) return { hits: hits(["https://www.linkedin.com/company/hayleys-plc"]), credits: 1 };
      if (q.includes("competitors") || q.startsWith("top ")) {
        return { hits: [{ url: "https://news.lk/x", title: "Conglomerates", snippet: "John Keells Holdings and Aitken Spence compete with Hayleys." }], credits: 1 };
      }
      if (q.includes("John Keells")) return { hits: hits(["https://www.keells.com", "https://www.linkedin.com/company/john-keells-holdings"]), credits: 1 };
      if (q.includes("Aitken Spence")) return { hits: hits(["https://www.aitkenspence.com"]), credits: 1 };
      return { hits: [{ url: "https://www.hayleys.com/", title: "Hayleys", snippet: "Diversified conglomerate in Colombo" }], credits: 1 };
    },
    readPage: async (url) => {
      read.push(url);
      if (url.startsWith("https://www.hayleys.com")) return "Hayleys is a diversified conglomerate headquartered in Colombo, Sri Lanka.";
      return url === "https://www.keells.com" ? "John Keells runs hotels and retail." : null;
    },
    model: async (_s, prompt) => {
      if (prompt.includes('"competitors": ["..."]')) return reply(JSON.stringify({ competitors: ["John Keells Holdings", "Aitken Spence", "Invented Group"] }));
      const keells = prompt.match(/\[(S\d+)\] John Keells Holdings — website/)?.[1] ?? "";
      return reply(
        JSON.stringify({
          similarDesignation: { value: "Group CFO", source: "S99" },
          services: { value: ["Plantations", "Leisure"], source: "S1" },
          country: { value: "Sri Lanka", source: "S1" },
          location: { value: "Colombo", source: "S1" },
          overview: { value: "A diversified conglomerate.", source: "S1, S5, S99" },
          competitors: [
            { name: "John Keells Holdings", whatTheyDo: { value: "Hotels and retail", source: keells }, location: { value: "", source: "" }, summary: { value: "Largest listed group.", source: "" } },
          ],
        }),
      );
    },
  };
  const r = await researchViaSearch({ clientName: "Hayleys PLC", industry: "Conglomerate", where: "Colombo", title: "CFO" }, deps);
  eq("it runs", r.ok, true);
  if (r.ok) {
    eq("website and LinkedIn are the addresses the search returned", [r.fields.websiteLink, r.fields.socialMedia], ["https://www.hayleys.com", "https://www.linkedin.com/company/hayleys-plc"]);
    eq("the client's own site is read", read.includes("https://www.hayleys.com"), true);
    eq("a competitor the search never named is dropped", r.fields.competitors, ["John Keells Holdings", "Aitken Spence"]);
    eq("each competitor is searched from three angles", queries.filter((q) => /John Keells|Aitken Spence/.test(q)).length, 6);
    eq("cited fields are kept", [r.fields.country, r.fields.location, r.fields.servicesProvider], ["Sri Lanka", "Colombo", ["Plantations", "Leisure"]]);
    eq("a field citing evidence that does not exist is empty", r.fields.similarDesignation, "");
    eq("several sources cited at once still count", r.fields.companyOverview, "A diversified conglomerate.");
    const jk = r.fields.competitorProfiles?.[0];
    eq("competitor site and LinkedIn from the search", [jk?.website, jk?.linkedin], ["https://www.keells.com", "https://www.linkedin.com/company/john-keells-holdings"]);
    eq("competitor text kept only where cited", [jk?.whatTheyDo, jk?.summary], ["Hotels and retail", ""]);
    eq("every search is counted", r.searches, queries.length);
  }
  const down = await researchViaSearch(
    { clientName: "Hayleys PLC", industry: "", where: "", title: "CFO" },
    { ...deps, model: async () => ({ ok: false as const, reason: "rate_limited" as const }) },
  );
  eq("model down: the addresses are still kept, with a note", down.ok && [down.fields.websiteLink, down.modelNote], ["https://www.hayleys.com", "rate_limited"]);
  eq("a confidential client is not searched", (await researchViaSearch({ clientName: "Confidential Client", industry: "", where: "", title: "CFO" }, deps)).ok, false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
