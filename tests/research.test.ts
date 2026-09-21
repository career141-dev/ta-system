import { parseResearch } from "@/lib/headhunt";
import { webEngine } from "@/lib/ai";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
