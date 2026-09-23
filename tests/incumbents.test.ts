import { aroundMentions, benchmarkByDefault, findIncumbents, seniorityOf, titleVariants, type IncumbentDeps } from "@/lib/incumbents";

let passed = 0;
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${g}, want ${w}`); }
};

console.log("which roles are benchmarked");
eq("CFO is C-level", seniorityOf("CFO"), "c_level");
eq("Chief Executive Officer is not an executive", seniorityOf("Chief Executive Officer"), "c_level");
eq("General Manager is C-level", seniorityOf("General Manager - Sales"), "c_level");
eq("Head of Finance is senior", seniorityOf("Head of Finance"), "senior");
eq("Finance Director is senior", seniorityOf("Finance Director"), "senior");
eq("Brand Manager is mid", seniorityOf("Brand Manager"), "mid");
eq("Marketing Executive is junior", seniorityOf("Marketing Executive"), "junior");
eq("an intern is junior", seniorityOf("Finance Intern"), "junior");
eq("benchmarked by default: C-level and senior only", ["CHRO", "Head of Branch Operations", "Brand Manager", "Marketing Executive"].map(benchmarkByDefault), [true, true, false, false]);
eq("CFO is searched both ways", titleVariants("CFO"), ["CFO", "Chief Financial Officer"]);

console.log("\nonly the part of a page that names the role");
const page = `${"x ".repeat(400)}Mr. Ruwan Perera — Chief Financial Officer. ${"y ".repeat(400)}`;
const bit = aroundMentions(page, ["Chief Financial Officer"], 60);
eq("keeps the mention and its neighbourhood", bit.includes("Ruwan Perera") && bit.length < 250, true);
eq("no mention, nothing", aroundMentions("About us. We make tea.", ["CFO"]), "");

console.log("\nwho holds it, with the web faked");
{
  const queries: string[] = [];
  const reply = (text: string) => ({ ok: true as const, text, sources: [], searches: 0, provider: "fake" });
  const deps: IncumbentDeps = {
    search: async (q) => {
      queries.push(q);
      if (q.startsWith("site:linkedin.com/in") && q.includes("Hayleys")) {
        return { hits: [{ url: "https://lk.linkedin.com/in/ruwan-perera-123", title: "Ruwan Perera - CFO - Hayleys PLC | LinkedIn", snippet: "Chief Financial Officer at Hayleys PLC" }], credits: 1 };
      }
      if (q.includes("Hayleys") && q.includes("former")) {
        return { hits: [{ url: "https://news.lk/cfo", title: "Hayleys appoints new CFO", snippet: "Ruwan Perera succeeds Nimal Silva, the former CFO of Hayleys PLC." }], credits: 1 };
      }
      if (q.includes("John Keells")) {
        return { hits: [{ url: "https://news.lk/jk", title: "JKH results", snippet: "Group CFO Anika Fernando said revenue grew." }], credits: 1 };
      }
      return { hits: [], credits: 1 };
    },
    readPage: async (url) => (url === "https://www.hayleys.com/leadership" ? "Board. Ruwan Perera, Chief Financial Officer. Dilani Silva, Company Secretary." : null),
    model: async () =>
      reply(
        JSON.stringify({
          people: [
            { company: "Hayleys PLC", name: "Ruwan Perera", title: "Chief Financial Officer", status: "current", source: "P1", confidence: "high", note: "Leadership page lists him as CFO" },
            { company: "Hayleys PLC", name: "Nimal Silva", title: "CFO", status: "former", source: "P3", confidence: "medium", note: "Named as former CFO in 2026 news" },
            { company: "Hayleys PLC", name: "Invented Person", title: "CFO", status: "current", source: "P1", confidence: "high", note: "" },
            { company: "John Keells Holdings", name: "Anika Fernando", title: "Group CFO", status: "current", source: "P4", confidence: "medium", note: "" },
            { company: "John Keells Holdings", name: "Someone Former", title: "CFO", status: "former", source: "P4", confidence: "low", note: "" },
          ],
        }),
      ),
  };
  const r = await findIncumbents(
    {
      title: "CFO",
      where: "Colombo",
      companies: [
        { name: "Hayleys PLC", website: "https://www.hayleys.com", isClient: true },
        { name: "John Keells Holdings", website: null, isClient: false },
      ],
    },
    deps,
  );
  const who = r.rows.map((x) => `${x.kind}:${x.name}@${x.company}`);
  eq("the client's current holder, the one before, and the competitor's", who, [
    "incumbent:Ruwan Perera@Hayleys PLC",
    "predecessor:Nimal Silva@Hayleys PLC",
    "competitor:Anika Fernando@John Keells Holdings",
  ]);
  eq("a name not in its cited evidence is dropped", who.some((w) => w.includes("Invented")), false);
  eq("a competitor's former holder is not kept", who.some((w) => w.includes("Someone Former")), false);
  eq("source is the leadership page it was cited from", r.rows[0].sourceUrl, "https://www.hayleys.com/leadership");
  eq("LinkedIn from a search result carrying the name", r.rows[0].linkedinUrl, "https://www.linkedin.com/in/ruwan-perera-123");
  eq("no LinkedIn result, no LinkedIn", r.rows[2].linkedinUrl, null);
  eq("five angles on the client, three on each competitor", queries.length, 8);
  eq("the client is asked who was there before", queries.some((q) => q.includes("Hayleys") && q.includes("former")), true);
  eq("no competitor is asked for a predecessor", queries.filter((q) => q.includes("John Keells")).length, 3);
  eq("both ways of writing the title are searched", queries[0].includes('"CFO" OR "Chief Financial Officer"'), true);

  const down = await findIncumbents(
    { title: "CFO", where: "", companies: [{ name: "Hayleys PLC", website: null, isClient: true }] },
    { ...deps, model: async () => ({ ok: false as const, reason: "rate_limited" as const }) },
  );
  eq("model down: nobody, with the reason", [down.rows.length, down.modelNote], [0, "rate_limited"]);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
