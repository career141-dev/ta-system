"use node";

// convex/communications/replyInbox.ts
//
// The recent messages in the desk's own mailboxes, for the app to read the
// Director's and clients' replies to a set (src/lib/graphInboxSync).
//
// The Microsoft settings live here, on the backend, where the end-of-day mail
// is already sent from. The app had none, so it never read a reply (5 Oct);
// asking here keeps the secret in one place instead of copying it to the app.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { getGraphToken } from "../lib/graphClient";

/** Only the desk's own mailboxes are read — never an address a caller makes up. */
const OURS = /@career141\.com$/i;
const MAX_BODY = 20_000;
/*
 * Never longer than this (6 Oct). A read with no time limit hung until the
 * backend's 300 s cut-off, and as the app asked again every 15 s they piled
 * up in the six action slots — an end-of-day send was then refused with "Too
 * many concurrent requests". A mailbox that does not answer in time is skipped.
 */
const PER_MAILBOX_MS = 15_000;
const WHOLE_READ_MS = 45_000;

export const recent = internalAction({
  args: { mailboxes: v.array(v.string()), top: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    const top = Math.min(Math.max(1, Math.floor(args.top ?? 15)), 50);
    const boxes = [...new Set(args.mailboxes.map((m) => m.trim().toLowerCase()).filter((m) => OURS.test(m)))];
    if (boxes.length === 0) return [];
    type Msg = { id: string; from: string; subject: string; receivedDateTime: string; bodyPreview: string; body: string };
    const out: Msg[] = [];
    const read = (async () => {
    const token = await getGraphToken();
    await Promise.all(boxes.map(async (box) => {
      const url =
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(box)}/mailFolders/inbox/messages` +
        `?$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime desc`;
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PER_MAILBOX_MS) });
        if (!res.ok) {
          console.warn(`[replyInbox] ${box}: HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as {
          value?: {
            id: string;
            subject?: string | null;
            from?: { emailAddress?: { address?: string | null } | null } | null;
            receivedDateTime?: string | null;
            bodyPreview?: string | null;
            body?: { content?: string | null } | null;
          }[];
        };
        for (const m of data.value ?? []) {
          out.push({
            id: m.id,
            from: m.from?.emailAddress?.address ?? "",
            subject: m.subject ?? "",
            receivedDateTime: m.receivedDateTime ?? "",
            bodyPreview: m.bodyPreview ?? "",
            body: (m.body?.content || m.bodyPreview || "").slice(0, MAX_BODY),
          });
        }
      } catch (e) {
        console.warn(`[replyInbox] ${box}: ${(e as Error).message}`);
      }
    }));
    })();
    // Whatever was read in time is returned; the rest waits for the next check.
    await Promise.race([read.catch((e) => console.warn(`[replyInbox] ${(e as Error).message}`)), new Promise((r) => setTimeout(r, WHOLE_READ_MS))]);
    return [...out];
  },
});
