export async function verifyElevenLabsSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(rawBody)
  );

  // Convert ArrayBuffer to hex string
  const signatureArray = Array.from(new Uint8Array(signatureBuffer));
  const expectedSignature = signatureArray
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing safe comparison - not strictly necessary in WebCrypto but good practice
  if (expectedSignature.length !== signatureHeader.length) return false;
  
  let result = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    result |= expectedSignature.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Meta's `X-Hub-Signature-256` on a WhatsApp Cloud API webhook.
 *
 * Why this exists: the four WhatsApp POST routes accepted anything that looked
 * like a Meta payload. The secret check in `communications/whatchimp.ts` is
 * skipped outright for a body shaped `entry[].changes[]`, and the callback URL
 * is visible to anyone who can see the app's configuration. A forged POST
 * created inbound `communications` rows, drove a DeepSeek reply and patched a
 * real candidate's record (23 September).
 *
 * Meta signs the **raw** request body with the app secret — App Dashboard →
 * Settings → Basic → App Secret, held as `META_APP_SECRET` on the deployment.
 * The body must be the exact bytes received: re-serialising the parsed JSON
 * changes the signature.
 *
 * Same HMAC-SHA256 as `verifyElevenLabsSignature` above; Meta differs only in
 * sending `sha256=<hex>` rather than bare hex. `crypto.subtle.verify` does the
 * comparison in constant time, so there is no hand-rolled loop here.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader || !appSecret) return false;
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signatureHeader)) return false;

  const hex = signatureHeader.slice("sha256=".length);
  const signature = Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify("HMAC", key, signature, enc.encode(rawBody));
}

/**
 * The webhook verification handshake's token, compared without leaking its
 * length or a prefix match through timing.
 */
export function verifyTokenMatches(
  received: string | null,
  expected: string | undefined
): boolean {
  if (!received || !expected) return false;
  if (received.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < received.length; i++) {
    result |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}
