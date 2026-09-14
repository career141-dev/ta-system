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
