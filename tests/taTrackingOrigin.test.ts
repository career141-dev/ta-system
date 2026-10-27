import assert from "node:assert/strict";
import { isTrackingSameOrigin } from "../src/lib/taTrackingOrigin";

const publicOrigin = "https://ta-system.career141.com";
const check = (url: string, headers: Record<string, string>) => isTrackingSameOrigin(new Request(url, { method: "POST", headers }));
assert.equal(check(`${publicOrigin}/api/ta-track`, { origin: publicOrigin }), true);
for (const origin of [publicOrigin, 'https://aura.career141.com']) {
  for (const host of ['ta-system.career141.com', 'aura.career141.com']) {
    assert.equal(check('http://0.0.0.0:3100/api/ta-track', { origin, host, 'x-forwarded-proto': 'https' }), true, 'both trusted aliases work even when the proxy uses the canonical host');
  }
}
assert.equal(check(`${publicOrigin}/api/ta-track`, { origin: 'https://aura.career141.com.attacker.example', host: 'aura.career141.com' }), false);
assert.equal(check(`${publicOrigin}/api/ta-track`, { origin: 'http://aura.career141.com', host: 'aura.career141.com', 'x-forwarded-proto': 'https' }), false);
// Production terminates HTTPS at the proxy, then forwards to a container over HTTP.
assert.equal(check("http://0.0.0.0:3100/api/ta-track", { origin: publicOrigin, host: "ta-system.career141.com", "x-forwarded-proto": "https" }), true);
assert.equal(check("http://ta-prod-app:3100/api/ta-track", { origin: publicOrigin, host: "ta-prod-app:3100", "x-forwarded-host": "ta-system.career141.com", "x-forwarded-proto": "https" }), true);
assert.equal(check("http://0.0.0.0:3100/api/ta-track", { origin: publicOrigin, host: "ta-system.career141.com" }), true);
assert.equal(check("http://localhost:3100/api/ta-track", { origin: "http://localhost:3100", host: "localhost:3100" }), true);
assert.equal(check("http://127.0.0.1:3100/api/ta-track", { origin: "http://127.0.0.1:3100" }), true);
for (const origin of ["https://attacker.example", "https://ta-system.career141.com.attacker.example", "http://ta-system.career141.com", "null", "chrome-extension://test", publicOrigin + "/", "https://user@ta-system.career141.com"]) {
  assert.equal(check("http://0.0.0.0:3100/api/ta-track", { origin, host: "ta-system.career141.com", "x-forwarded-proto": "https" }), false, origin);
}
assert.equal(check(`${publicOrigin}/api/ta-track`, {}), false);
assert.equal(check(`${publicOrigin}/api/ta-track`, { origin: publicOrigin, "x-forwarded-host": "ta-system.career141.com,attacker.example" }), false);
assert.equal(check(`${publicOrigin}/api/ta-track`, { origin: publicOrigin, "x-forwarded-proto": "https,http" }), false);
assert.equal(check(`${publicOrigin}/api/ta-track`, { origin: publicOrigin, "x-forwarded-host": "ta-system.career141.com/extra" }), false);
assert.equal(check("http://localhost:3100/api/ta-track", { origin: "http://localhost:3200" }), false);
console.log("TA Track origin checks: production proxy, local development, cross-site rejection and malformed headers passed.");
