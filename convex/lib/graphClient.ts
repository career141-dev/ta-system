"use node";

/**
 * Microsoft Graph OAuth 2.0 Client-Credentials Token Helper
 *
 * Fetches and caches an access token for the Microsoft Graph API using the
 * tenant-level client-credentials grant flow.
 *
 * Environment variables required (set via Convex dashboard):
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
 */

let cachedToken: string | null = null;
let tokenExpiryTime: number = 0;

/**
 * Returns a valid MS Graph access token, fetching a fresh one only when the
 * cached token is missing or about to expire (within 5 minutes).
 */
export async function getGraphToken(): Promise<string> {
  const now = Date.now();

  // Return cached token if it's still valid (with 5-minute buffer)
  if (cachedToken && tokenExpiryTime - now > 5 * 60 * 1000) {
    return cachedToken;
  }

  const tenantId = process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "[Graph Client] Missing MS_GRAPH_TENANT_ID/MS_TENANT_ID, MS_GRAPH_CLIENT_ID/MS_CLIENT_ID, or MS_GRAPH_CLIENT_SECRET/MS_CLIENT_SECRET environment variables."
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", "https://graph.microsoft.com/.default");
  params.append("grant_type", "client_credentials");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `[Graph Client] Token request failed (${res.status}): ${errorText}`
    );
  }

  const data = await res.json();

  cachedToken = data.access_token as string;
  // Microsoft tokens typically last 3600 seconds; respect the actual expiry
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  tokenExpiryTime = now + expiresInMs;

  console.log(
    `[Graph Client] Access token acquired, expires in ${data.expires_in}s`
  );

  return cachedToken;
}
