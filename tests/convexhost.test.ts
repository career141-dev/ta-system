/**
 * Which backend the app may talk to (src/lib/convexHost.ts).
 *
 * The admin key writes anything, so a test copy must not be able to reach a
 * remote backend by changing one URL. Only this machine, or — on a deployment
 * that says it is production — the one host it names.
 */
import { backendHostAllowed } from "../src/lib/convexHost";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("this machine");
ok("loopback is allowed", backendHostAllowed("http://127.0.0.1:3210").ok);
ok("localhost is allowed", backendHostAllowed("http://localhost:3210").ok);

console.log("\nanywhere else");
ok("a remote backend is refused", !backendHostAllowed("https://api.career141.com").ok);
ok("the refusal says how to allow it deliberately", /C141_CONVEX_HOST=api\.career141\.com/.test((backendHostAllowed("https://api.career141.com") as { message: string }).message));
ok("not a URL is refused", !backendHostAllowed("backend:3210").ok);

console.log("\nthe named exception");
ok("a named host without the production flag is refused", !backendHostAllowed("http://backend:3210", { allowedHost: "backend" }).ok);
ok("production alone, without naming the host, is refused", !backendHostAllowed("http://backend:3210", { deployment: "production" }).ok);
ok("production naming its own backend is allowed", backendHostAllowed("http://backend:3210", { deployment: "production", allowedHost: "backend" }).ok);
ok("a different host than the one named is refused", !backendHostAllowed("https://api.career141.com", { deployment: "production", allowedHost: "backend" }).ok);
ok("staging naming its own backend is allowed", backendHostAllowed("http://convex:3210", { deployment: "staging", allowedHost: "convex" }).ok);
ok("any other deployment value is refused", !backendHostAllowed("http://convex:3210", { deployment: "test", allowedHost: "convex" }).ok);
ok("the name is compared without case", backendHostAllowed("http://Backend:3210", { deployment: "production", allowedHost: "backend" }).ok);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
