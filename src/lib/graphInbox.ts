import "server-only";

/**
 * Microsoft Graph Inbox Reader for Next.js Server.
 *
 * Reads recent incoming emails from Microsoft 365 mailboxes directly
 * using the application's Graph credentials in environment variables.
 */

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function getGraphAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt - now > 5 * 60 * 1000) {
    return cachedToken;
  }

  const tenantId = process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing Microsoft Graph credentials in environment (MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET)."
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
    cache: "no-store",
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`[Graph Client] Token request failed (${res.status}): ${errorText.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("[Graph Client] Token response did not contain access_token.");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

export interface InboundEmail {
  id: string;
  from: string;
  subject: string;
  receivedDateTime: string;
  bodyPreview: string;
  body: string;
}

/**
 * Fetch recent messages across given mailboxes.
 */
export async function fetchMailboxMessages(
  mailboxes: string[],
  top = 25
): Promise<InboundEmail[]> {
  const token = await getGraphAccessToken();
  const results: InboundEmail[] = [];

  for (const mailbox of mailboxes) {
    const box = (mailbox ?? "").trim();
    if (!box) continue;
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
        box
      )}/mailFolders/inbox/messages?$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime desc`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (!res.ok) {
        console.warn(`[graphInbox] Mailbox query for ${box} returned HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as {
        value?: {
          id: string;
          subject?: string | null;
          from?: { emailAddress?: { address?: string | null } | null } | null;
          receivedDateTime?: string | null;
          bodyPreview?: string | null;
          body?: { content?: string | null } | string | null;
        }[];
      };

      for (const m of data.value ?? []) {
        const from = m.from?.emailAddress?.address ?? "";
        const bodyContent =
          typeof m.body === "object" && m.body !== null ? m.body.content ?? "" : typeof m.body === "string" ? m.body : "";
        results.push({
          id: m.id,
          from,
          subject: m.subject ?? "",
          receivedDateTime: m.receivedDateTime ?? "",
          bodyPreview: m.bodyPreview ?? "",
          body: bodyContent || m.bodyPreview || "",
        });
      }
    } catch (e) {
      console.warn(`[graphInbox] Failed to read messages for ${box}:`, (e as Error).message);
    }
  }

  return results;
}
