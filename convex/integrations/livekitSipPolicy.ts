const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export function e164Phone(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return E164_PHONE.test(trimmed) ? trimmed : null;
}

export function isOutboundCallTestMode(input: {
  callTestMode: string | undefined;
  outreachTestMode: string | undefined;
  globalTestMode: string | undefined;
  settingsTestMode: boolean | undefined;
}) {
  return (
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
