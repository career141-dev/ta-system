const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export function e164Phone(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return E164_PHONE.test(trimmed) ? trimmed : null;
}

/**
 * Whether an outbound call goes to the test recipient instead of the candidate.
 *
 * `outreachLive` is outreachSafety's decision (OUTREACH_LIVE=true). A real call
 * needs it as well as the call switches: CALL_TEST_MODE=false and a database
 * setting were enough on their own to ring real candidates while every
 * message to them was held in test mode (2 Oct).
 */
export function isOutboundCallTestMode(input: {
  outreachLive: boolean;
  callTestMode: string | undefined;
  outreachTestMode: string | undefined;
  globalTestMode: string | undefined;
  settingsTestMode: boolean | undefined;
}) {
  return (
    !input.outreachLive ||
    input.callTestMode !== "false" ||
    input.outreachTestMode === "true" ||
    input.globalTestMode === "true" ||
    input.settingsTestMode !== false
  );
}

export function resolveOutboundRecipient(input: {
  isTestMode: boolean;
  candidatePhone: string | undefined;
  testRecipient: string | undefined;
}):
  | { outcome: "dial"; recipient: string }
  | { outcome: "suppressed" }
  | { outcome: "invalid_candidate" } {
  if (input.isTestMode) {
    const recipient = e164Phone(input.testRecipient);
    return recipient
      ? { outcome: "dial", recipient }
      : { outcome: "suppressed" };
  }

  const recipient = e164Phone(input.candidatePhone);
  return recipient
    ? { outcome: "dial", recipient }
    : { outcome: "invalid_candidate" };
}
