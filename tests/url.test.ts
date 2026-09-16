import { externalUrl } from "@/lib/url";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
