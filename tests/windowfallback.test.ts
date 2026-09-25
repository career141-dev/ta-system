/**
 * Meta decides whether its own 24-hour window is open — not our database.
 *
 * `sendWhatsApp` guesses the window from our `communications` rows. That guess
 * is wrong more often than it looks: the same phone number sits on several
 * candidate records, so a reply logged against one leaves another looking
 * silent — or looking active when Meta disagrees. When the guess said "open"
 * and Meta said 131047, the free text was rejected and the candidate received
 * NOTHING. The TA pressed Send and no message arrived; sending "hi" from the
 * candidate's phone made the next attempt work, which is what made it look
 * intermittent (25 September).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isOutsideWindowError } from "../convex/communications/metaDirectSender";

test("recognises Meta's outside-the-window refusal", () => {
  const body = JSON.stringify({
    error: {
      message: "(#131047) Re-engagement message",
      type: "OAuthException",
      code: 131047,
      error_data: {
        details:
          "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
      },
    },
  });
  assert.equal(isOutsideWindowError(body), true);
});

test("recognises the undeliverable-recipient refusal", () => {
  assert.equal(isOutsideWindowError(JSON.stringify({ error: { code: 131026 } })), true);
});

test("does not mistake other failures for a closed window", () => {
  // These must keep failing loudly — a template would not fix any of them.
  const others = [
    { error: { code: 131000, message: "Something went wrong" } },
    { error: { code: 132001, message: "Template name does not exist" } },
    { error: { code: 132018, message: "Parameter format does not match" } },
    { error: { code: 190, message: "Access token expired" } },
    { error: { code: 100, message: "Invalid parameter" } },
  ];
  for (const body of others) {
    assert.equal(
      isOutsideWindowError(JSON.stringify(body)),
      false,
      `code ${body.error.code} must not trigger the template fallback`,
    );
  }
});

test("survives a response that is not JSON", () => {
  // Meta returns HTML on some gateway errors; the helper must not throw.
  assert.equal(isOutsideWindowError("<html>502 Bad Gateway</html>"), false);
  assert.equal(isOutsideWindowError(""), false);
  assert.equal(isOutsideWindowError("upstream timeout"), false);
});

test("still matches when the code only appears in the raw text", () => {
  assert.equal(isOutsideWindowError("HTTP 400: (#131047) Re-engagement message"), true);
});

test("a number that merely contains the digits is not a match", () => {
  // Word-boundary matching: a message id or timestamp must not trigger it.
  assert.equal(isOutsideWindowError("wamid.HBgLOTQ3NTM4ODMxNjc1131047123"), false);
});
