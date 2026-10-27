export interface TrackingLoginRequest {
  email: string;
  tokenHash: string;
}

export function trackingLoginRequest(input: Record<string, unknown>): TrackingLoginRequest {
  const email = String(input.email ?? "").trim().toLowerCase();
  const tokenHash = String(input.tokenHash ?? "");
  if (!/^[^\s@]+@career141\.com$/.test(email)) throw new Error("Use your Career141 email address.");
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error("Start tracking from the browser tracker extension.");
  return { email, tokenHash };
}
