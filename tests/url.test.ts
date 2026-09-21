import { externalUrl, profileLink } from "@/lib/url";

let passed = 0;
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (got === want) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log("external links");
eq("no scheme becomes https", externalUrl("linkedin.com/in/vishwa-fernando-85519495"), "https://linkedin.com/in/vishwa-fernando-85519495");
eq("www without scheme", externalUrl("www.linkedin.com/in/paramsothy-%20nirosan-a6096022"), "https://www.linkedin.com/in/paramsothy-%20nirosan-a6096022");
eq("space inside the slug is dropped", externalUrl("www.linkedin.com/in/paramsothy- nirosan-a6096022"), "https://www.linkedin.com/in/paramsothy-nirosan-a6096022");
eq("a full address is kept", externalUrl("https://www.linkedin.com/in/x-1/"), "https://www.linkedin.com/in/x-1/");
eq("protocol-relative", externalUrl("//linkedin.com/in/x"), "https://linkedin.com/in/x");
eq("javascript is refused", externalUrl("javascript:alert(1)"), null);
eq("a bare word is refused", externalUrl("linkedin"), null);
eq("empty", externalUrl("  "), null);
eq("null", externalUrl(null), null);

console.log("\nprofiles pasted into Excel Tables");
eq("no scheme is accepted", profileLink("linkedin.com/in/vishwa-fernando-85519495")?.url, "https://www.linkedin.com/in/vishwa-fernando-85519495");
eq("country subdomain and slash share a key", profileLink("https://lk.linkedin.com/in/Vishwa-Fernando-85519495/")?.key, "linkedin.com/in/vishwa-fernando-85519495");
eq("query is dropped", profileLink("www.linkedin.com/in/nimal-perera?trk=x")?.url, "https://www.linkedin.com/in/nimal-perera");
eq("a name is read from the address", profileLink("linkedin.com/in/vishwa-fernando-85519495")?.guessedName, "Vishwa Fernando");
eq("hex suffix is dropped", profileLink("linkedin.com/in/sahan-gunarathna-a6096022")?.guessedName, "Sahan Gunarathna");
eq("an id-only slug has no name", profileLink("linkedin.com/in/ACoAAB12345")?.guessedName, null);
eq("a company page is not a profile", profileLink("linkedin.com/company/hayleys"), null);
eq("not linkedin", profileLink("github.com/in/x"), null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
