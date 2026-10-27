import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasPartnerBearerToken, partnerPageOptions } from "../convex/lib/partnerReadAuth";
import { PARTNER_PRIVATE_TABLES, PARTNER_READ_TABLES, readTablePage, redactPartnerSecrets } from "../convex/integrations/partnerRead";

const schema = readFileSync(path.resolve("convex/schema.ts"), "utf8");
const schemaTables = [...schema.matchAll(/^  ([A-Za-z][A-Za-z0-9_]*): defineTable\(/gm)].map((m) => m[1]);
assert.deepEqual([...PARTNER_READ_TABLES, ...PARTNER_PRIVATE_TABLES].sort(), schemaTables.sort(), "Partner table registry must classify the full app schema");
assert.equal(new Set(PARTNER_READ_TABLES).size, PARTNER_READ_TABLES.length, "Partner table registry has duplicate names");
for (const table of PARTNER_PRIVATE_TABLES) {
  assert.equal((PARTNER_READ_TABLES as readonly string[]).includes(table), false);
  await assert.rejects(() => (readTablePage as any)._handler({}, { table, limit: 50 }), /Unknown table/);
}

const testToken = "a".repeat(43);
assert.equal(await hasPartnerBearerToken(`Bearer ${testToken}`, testToken), true);
assert.equal(await hasPartnerBearerToken(`Bearer ${"b".repeat(43)}`, testToken), false);
assert.equal(await hasPartnerBearerToken(null, testToken), false);
assert.equal(await hasPartnerBearerToken(`Bearer ${testToken}`, undefined), false);
assert.equal(await hasPartnerBearerToken(`Bearer ${"a".repeat(42)}`, testToken), false);
assert.equal(await hasPartnerBearerToken(`bearer ${testToken}`, testToken), false);

assert.deepEqual(partnerPageOptions(new URL("https://api.example.test/integrations/v1/tables/candidates")), { limit: 50 });
assert.deepEqual(partnerPageOptions(new URL("https://api.example.test/?limit=100&cursor=opaque")), { limit: 100, cursor: "opaque" });
for (const query of ["?limit=0", "?limit=101", "?limit=2.5", "?limit=nope", `?cursor=${"x".repeat(2049)}`]) {
  assert.equal(partnerPageOptions(new URL(`https://api.example.test/${query}`)), null, `Rejected ${query}`);
}

assert.deepEqual(redactPartnerSecrets({ profile: { name: "A" }, accessToken: "private", refreshToken: "private" }), {
  profile: { name: "A" }, accessToken: "[REDACTED]", refreshToken: "[REDACTED]",
});
assert.deepEqual(redactPartnerSecrets({ state: "private" }, "oauthStates"), { state: "[REDACTED]" });
assert.deepEqual(redactPartnerSecrets({ deltaLink: "private", mailbox: "cv@company.test" }, "mailIntakeMailboxes"), {
  deltaLink: "[REDACTED]", mailbox: "cv@company.test",
});

console.log("  ok  partner API auth, paging, table coverage, and secret redaction");
