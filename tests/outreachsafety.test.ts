import { deliveryMode, internationalPhone, mayReplyTo, outreachLive, resolveRecipient } from "../convex/lib/outreachSafety";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const env = (vars: Record<string, string | undefined>) => {
  for (const k of ["OUTREACH_LIVE", "OUTREACH_TEST_EMAIL", "OUTREACH_TEST_PHONE"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
};

// ── Default: nothing set → never a real send, and nothing at all ────────────
env({});
eq("not live by default", outreachLive(), false);
eq("email blocked with no test recipient", resolveRecipient("email", "real@candidate.com").ok, false);
eq("whatsapp blocked with no test recipient", resolveRecipient("whatsapp", "+94 77 123 4567").ok, false);

// ── Anything but exactly "true" stays in test mode ──────────────────────────
for (const v of ["false", "1", "yes", "TRUE ", ""]) {
  env({ OUTREACH_LIVE: v, OUTREACH_TEST_EMAIL: "me@career141.com" });
  const r = resolveRecipient("email", "real@candidate.com");
  eq(`OUTREACH_LIVE=${JSON.stringify(v)} redirects`, r.ok && r.to, v.trim().toLowerCase() === "true" ? "real@candidate.com" : "me@career141.com");
}

// ── Test mode with recipients → redirected ──────────────────────────────────
env({ OUTREACH_TEST_EMAIL: "Me@Career141.com", OUTREACH_TEST_PHONE: "+94 77 000 1111" });
let r = resolveRecipient("email", "real@candidate.com");
eq("email redirected to test mailbox", r.ok && [r.to, r.redirected], ["me@career141.com", true]);
r = resolveRecipient("whatsapp", "0771234567");
eq("whatsapp redirected to test phone (digits)", r.ok && [r.to, r.redirected], ["94770001111", true]);
r = resolveRecipient("whatsapp", "+94-77-000-1111");
eq("the test phone itself is not a redirect", r.ok && r.redirected, false);

// ── Thread replies cannot be redirected: only to the test sender ────────────
eq("reply to real candidate blocked", mayReplyTo("email", "real@candidate.com").ok, false);
eq("reply to unknown sender blocked", mayReplyTo("email", undefined).ok, false);
eq("reply to test mailbox allowed", mayReplyTo("email", "me@career141.com").ok, true);

// ── Live → the intended person ──────────────────────────────────────────────
env({ OUTREACH_LIVE: "true" });
r = resolveRecipient("email", "Real@Candidate.com");
eq("live sends to the candidate", r.ok && [r.to, r.redirected], ["real@candidate.com", false]);
eq("live still refuses an empty address", resolveRecipient("whatsapp", "").ok, false);
eq("live allows thread replies", mayReplyTo("email", "real@candidate.com").ok, true);
const lk = resolveRecipient("whatsapp", "0703205525");
eq("a local Sri Lankan number is sent as 94…", lk.ok && lk.to, "94703205525");
eq("+94 stays as it is", internationalPhone("+94 70 320 5525"), "94703205525");
eq("0094 loses its 00", internationalPhone("0094703205525"), "94703205525");
eq("live says live", deliveryMode("whatsapp"), "live");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
