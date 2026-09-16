import { emailAllowed, outboundLocked, phoneAllowed } from "../convex/lib/outboundGuard";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
};

const quiet = console.warn;
console.warn = () => {};

console.log("unlocked (production default)");
delete process.env.C141_OUTBOUND_LOCK;
ok("not locked", !outboundLocked());
ok("any phone allowed", phoneAllowed("+94 77 123 4567"));
ok("any email allowed", emailAllowed("candidate@example.com"));

console.log("locked, empty allow-list");
process.env.C141_OUTBOUND_LOCK = "true";
delete process.env.C141_OUTBOUND_ALLOW_PHONES;
delete process.env.C141_OUTBOUND_ALLOW_EMAILS;
ok("locked", outboundLocked());
ok("a real phone is refused", !phoneAllowed("+94 77 123 4567"));
ok("a real email is refused", !emailAllowed("candidate@example.com"));
ok("an empty recipient is refused", !phoneAllowed("") && !emailAllowed(""));

console.log("locked, with a test number and address");
process.env.C141_OUTBOUND_ALLOW_PHONES = "+94 71 000 1111";
process.env.C141_OUTBOUND_ALLOW_EMAILS = "qa@c141-test.invalid";
ok("the test number in another format is allowed", phoneAllowed("0710001111") && phoneAllowed("94710001111"));
ok("a number differing in one digit is refused", !phoneAllowed("0710001112"));
ok("the test address is allowed, any case", emailAllowed("QA@c141-test.invalid"));
ok("a list containing one real address is refused", !emailAllowed(["qa@c141-test.invalid", "candidate@example.com"]));
ok("\"true\" is the only value that locks", (process.env.C141_OUTBOUND_LOCK = "yes", !outboundLocked()));

console.warn = quiet;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
