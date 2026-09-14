const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TRANSCRIPT_CHARACTERS = 100_000;

export type VoiceAgentEvent =
  | {
      type: "consent";
      callSessionId: string;
      decision: "granted" | "declined";
      idempotencyKey: string;
      expectedStateVersion: number;
    }
  | {
      type: "confirmed_answer";
      callSessionId: string;
      turnId: string;
      field: "currentSalary" | "expectedSalary" | "noticePeriodDays";
      value: number;
      currency?: string;
      expectedStateVersion: number;
    }
  | {
      type: "finalize";
      callSessionId: string;
      expectedStateVersion: number;
      status: "completed" | "failed" | "cancelled";
      durationSeconds: number;
      transcript: string;
    };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Request body contains unsupported fields");
  }
  if (required.some((key) => !(key in value))) {
    throw new Error("Request body is missing required fields");
  }
}

function text(value: unknown, name: string, maxLength: number) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function parseVoiceAgentEvent(value: unknown): VoiceAgentEvent {
  const body = record(value);
  if (body.type === "consent") {
    exactKeys(body, [
      "type",
      "callSessionId",
      "decision",
      "idempotencyKey",
      "expectedStateVersion",
    ]);
    if (body.decision !== "granted" && body.decision !== "declined") {
      throw new Error("Invalid consent decision");
    }
    return {
      type: "consent",
      callSessionId: text(body.callSessionId, "callSessionId", 200),
      decision: body.decision,
      idempotencyKey: text(body.idempotencyKey, "idempotencyKey", 128),
      expectedStateVersion: nonNegativeInteger(
        body.expectedStateVersion,
        "expectedStateVersion",
      ),
    };
  }

  if (body.type === "confirmed_answer") {
    exactKeys(
      body,
      [
        "type",
        "callSessionId",
        "turnId",
        "field",
        "value",
        "expectedStateVersion",
      ],
      ["currency"],
    );
    if (
      body.field !== "currentSalary" &&
      body.field !== "expectedSalary" &&
      body.field !== "noticePeriodDays"
    ) {
      throw new Error("Invalid confirmed-answer field");
    }
    if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
      throw new Error("value must be a finite number");
    }
    if (body.field === "noticePeriodDays" && body.currency !== undefined) {
      throw new Error("currency is forbidden for noticePeriodDays");
    }
    if (
      body.field !== "noticePeriodDays" &&
      (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency))
    ) {
      throw new Error("Salary answers require an uppercase currency code");
    }
    return {
      type: "confirmed_answer",
      callSessionId: text(body.callSessionId, "callSessionId", 200),
      turnId: text(body.turnId, "turnId", 128),
      field: body.field,
      value: body.value,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      expectedStateVersion: nonNegativeInteger(
        body.expectedStateVersion,
        "expectedStateVersion",
      ),
    };
  }

  if (body.type === "finalize") {
    exactKeys(body, [
      "type",
      "callSessionId",
      "expectedStateVersion",
      "status",
      "durationSeconds",
      "transcript",
    ]);
    if (
      body.status !== "completed" &&
      body.status !== "failed" &&
      body.status !== "cancelled"
    ) {
      throw new Error("Invalid final voice status");
    }
    if (
      typeof body.transcript !== "string" ||
      body.transcript.length > MAX_TRANSCRIPT_CHARACTERS
    ) {
      throw new Error("Invalid transcript");
    }
    return {
      type: "finalize",
      callSessionId: text(body.callSessionId, "callSessionId", 200),
      expectedStateVersion: nonNegativeInteger(
        body.expectedStateVersion,
        "expectedStateVersion",
      ),
      status: body.status,
      durationSeconds: nonNegativeInteger(
        body.durationSeconds,
        "durationSeconds",
      ),
      transcript: body.transcript,
    };
  }

  throw new Error("Unsupported voice-agent event type");
}

export function isFreshVoiceAgentTimestamp(
  timestamp: string | null,
  now = Date.now(),
) {
  if (!timestamp || !/^\d{10,13}$/.test(timestamp)) return false;
  const parsed = Number(timestamp);
  if (!Number.isSafeInteger(parsed)) return false;
  const milliseconds = timestamp.length <= 10 ? parsed * 1000 : parsed;
  return Math.abs(now - milliseconds) <= MAX_CLOCK_SKEW_MS;
}

export async function verifyVoiceAgentSignature(input: {
  rawBody: string;
  timestamp: string;
  nonce: string;
  signature: string | null;
  secret: string;
}) {
  if (!input.signature || !/^[a-fA-F0-9]{64}$/.test(input.signature)) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(
    input.signature.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${input.timestamp}.${input.nonce}.${input.rawBody}`),
  );
}
