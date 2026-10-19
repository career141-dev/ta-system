// convex/mailIntake/sync.ts
//
// Finding new messages in a shared mailbox, with Microsoft Graph's delta query.
//
// The CV platform's poller asks for unread mail since a timestamp, 15 at a
// time, and marks each one read. That is why it can skip messages (the
// timestamp moves past the ones it did not reach) and why a second reader would
// steal its mail. A delta query needs neither: Graph hands back exactly what
// changed since the last token, however many there are, and nothing in the
// mailbox is touched. The only permission it needs is Mail.Read.
//
// This action only RECORDS messages (mailIntakeMessages). Reading and filing
// them is process.ts, one message at a time.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getGraphToken } from "../lib/graphClient";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Pages per run; a long backfill carries on at the next tick from `nextLink`. */
const MAX_PAGES = 20;

type DeltaMessage = {
  id: string;
  subject?: string | null;
  receivedDateTime?: string | null;
  hasAttachments?: boolean | null;
  conversationId?: string | null;
  internetMessageId?: string | null;
  from?: { emailAddress?: { address?: string | null } | null } | null;
  "@removed"?: unknown;
};

export const syncMailbox = internalAction({
  args: { mailbox: v.string() },
  handler: async (ctx, args): Promise<{ recorded: number; pages: number; done: boolean; error?: string }> => {
    const box = await ctx.runQuery(internal.mailIntake.model.mailbox, { mailbox: args.mailbox });
    // A TA's own mailbox is not read (29 Sep): scoops are uploaded on the opening's Scoops page.
    if (!box || !box.enabled || box.kind === "ta") return { recorded: 0, pages: 0, done: true };

    const since = new Date(box.backfillFrom).toISOString();
    let url =
      box.nextLink ??
      box.deltaLink ??
      `${GRAPH}/users/${encodeURIComponent(args.mailbox)}/mailFolders/inbox/messages/delta` +
        `?$select=subject,from,receivedDateTime,hasAttachments,conversationId,internetMessageId` +
        `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;

    let recorded = 0;
    let pages = 0;
    try {
      const token = await getGraphToken();
      for (;;) {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Prefer: "odata.maxpagesize=50" },
        });
        if (res.status === 410) {
          // The delta token expired (Graph keeps them for a limited time). Start
          // again from the backfill window; messages already logged are skipped.
          await ctx.runMutation(internal.mailIntake.model.saveSyncState, {
            mailbox: args.mailbox, deltaLink: null, nextLink: null, error: "Sync token expired; starting a fresh sync.", seenAdded: 0,
          });
          return { recorded, pages, done: false, error: "delta token expired" };
        }
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Graph answered ${res.status}; will try again at the next sync.`);
        }
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          throw new Error(
            res.status === 403
              ? `Graph refused access to ${args.mailbox} (403). The app registration needs the Mail.Read application permission for this mailbox. ${body}`
              : `Graph answered ${res.status}: ${body}`,
          );
        }
        const json = (await res.json()) as { value?: DeltaMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
        pages++;

        const messages = (json.value ?? [])
          // A delta also reports messages deleted or changed (marked read by the
          // CV platform, for one). Only a message we have not logged matters,
          // and recordMessages skips those it has.
          .filter((m) => !m["@removed"] && m.id && m.receivedDateTime)
          .map((m) => ({
            messageId: m.id,
            receivedAt: Date.parse(m.receivedDateTime!),
            subject: (m.subject ?? "").slice(0, 500),
            fromAddress: (m.from?.emailAddress?.address ?? "").toLowerCase(),
            hasAttachments: Boolean(m.hasAttachments),
            conversationId: m.conversationId ?? undefined,
            internetMessageId: m.internetMessageId ?? undefined,
          }))
          .filter((m) => m.receivedAt >= box.backfillFrom);
        if (messages.length) {
          const { added } = await ctx.runMutation(internal.mailIntake.model.recordMessages, { mailbox: args.mailbox, messages });
          recorded += added;
        }

        if (json["@odata.deltaLink"]) {
          await ctx.runMutation(internal.mailIntake.model.saveSyncState, {
            mailbox: args.mailbox, deltaLink: json["@odata.deltaLink"], nextLink: null, error: null, seenAdded: recorded,
          });
          return { recorded, pages, done: true };
        }
        if (!json["@odata.nextLink"]) throw new Error("Graph returned neither a next page nor a delta token.");
        url = json["@odata.nextLink"];
        if (pages >= MAX_PAGES) {
          await ctx.runMutation(internal.mailIntake.model.saveSyncState, {
            mailbox: args.mailbox, nextLink: url, error: null, seenAdded: recorded,
          });
          return { recorded, pages, done: false };
        }
      }
    } catch (e) {
      const error = (e as Error).message ?? String(e);
      await ctx.runMutation(internal.mailIntake.model.saveSyncState, {
        mailbox: args.mailbox, error: error.slice(0, 500), seenAdded: recorded,
      });
      return { recorded, pages, done: false, error };
    }
  },
});

/** The cron's entry: make sure the mailboxes exist, then sync each one that is switched on. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    await ctx.runMutation(internal.mailIntake.model.ensureMailboxes, {});
    const boxes: { mailbox: string }[] = await ctx.runQuery(internal.mailIntake.model.enabledMailboxes, {});
    const results: Record<string, unknown> = {};
    for (const b of boxes) {
      results[b.mailbox] = await ctx.runAction(internal.mailIntake.sync.syncMailbox, { mailbox: b.mailbox });
    }
    return results;
  },
});
