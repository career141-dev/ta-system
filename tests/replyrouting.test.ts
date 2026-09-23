/**
 * A reply is answered on the channel it arrived on, and filed against the
 * opening it belongs to.
 *
 * Three bugs lived here (23 September):
 *   1. `graphEmailMutations` and one `emailAgent` path never passed `channel`,
 *      and `extractDetailsFromText` treats anything that is not "email" as
 *      WhatsApp — so a candidate's EMAIL was answered over WhatsApp.
 *   2. No caller passed `applicationId`, so the application was re-guessed from
 *      the most recent OUTBOUND message on ANY channel. A candidate on two
 *      openings, emailed about one and replying on WhatsApp about the other,
 *      had the answer filed against the emailed opening.
 *   3. The AI's conversation history was read across every application, so it
 *      answered from whichever opening had been talked about most recently.
 *
 * These assert the contract the call sites must keep. They read the source
 * rather than run Convex: the call sites are what regressed, and a missing
 * argument is invisible to the type checker because both fields are optional.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** The argument block of each extractDetailsFromText call in a file. */
function extractionCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "inboundExtraction.extractDetailsFromText";
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    const open = source.indexOf("{", from);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

test("every email path says it is email", () => {
  for (const file of [
    "convex/communications/graphEmailMutations.ts",
    "convex/communications/emailAgent.ts",
    "convex/mailIntake/process.ts",
  ]) {
    const calls = extractionCalls(read(file));
    assert.ok(calls.length > 0, `no extraction call found in ${file}`);
    for (const call of calls) {
      assert.match(
        call,
        /channel:\s*"email"/,
        `${file} schedules extraction without channel:"email" — the reply would go out over WhatsApp`,
      );
    }
  }
});

test("the WhatsApp path says it is WhatsApp", () => {
  for (const call of extractionCalls(read("convex/communications/whatsappOutbound.ts"))) {
    assert.match(call, /channel:\s*"whatsapp"/, "the WhatsApp reply path must name its channel");
  }
});

test("both live reply paths pin the application", () => {
  for (const file of [
    "convex/communications/whatsappOutbound.ts",
    "convex/communications/graphEmailMutations.ts",
  ]) {
    for (const call of extractionCalls(read(file))) {
      assert.match(
        call,
        /applicationId:/,
        `${file} leaves the application to be re-guessed from the last outbound on any channel`,
      );
    }
  }
});

test("conversation history is scoped to one application", () => {
  const source = read("convex/communications/inboundExtraction.ts");
  const query = source.slice(source.indexOf("export const getRecentHistoryQuery"));
  assert.match(query, /applicationId/, "history must be scoped, or the AI sees another opening's thread");
  assert.match(
    query,
    /m\.applicationId === args\.applicationId/,
    "history must filter on the application, not merely accept the argument",
  );
});

test("the extraction verifies the application belongs to the candidate", () => {
  const source = read("convex/communications/inboundExtraction.ts");
  assert.match(
    source,
    /app\.candidateId !== args\.candidateId/,
    "an applicationId arriving from a webhook must be checked, not trusted",
  );
});
