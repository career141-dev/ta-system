"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getGraphToken } from "../lib/graphClient";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Renew any Graph webhook subscriptions expiring within 24 hours.
 * Called by a daily cron job in crons.ts.
 */
export const renewExpiringSubscriptions = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const twentyFourHoursFromNow = now + 24 * 60 * 60 * 1000;

    // Query subscriptions expiring soon
    const expiringSubs: any[] = await ctx.runQuery(
      internal.communications.graphSubscriptionQueries.getExpiringSubs,
      { expiryThreshold: twentyFourHoursFromNow }
    );

    if (expiringSubs.length === 0) {
      console.log("[Graph Subscriptions] No subscriptions need renewal.");
      return;
    }

    const token = await getGraphToken();

    for (const sub of expiringSubs) {
      try {
        // Renew for 3 more days (max for mail subscriptions is 4230 minutes ≈ 2.94 days)
        const newExpiry = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();

        const res = await fetch(
          `${GRAPH_BASE}/subscriptions/${sub.subscriptionId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              expirationDateTime: newExpiry,
            }),
          }
        );

        if (!res.ok) {
          const errorText = await res.text();
          console.error(
            `[Graph Subscriptions] Failed to renew ${sub.subscriptionId}: ${res.status} ${errorText}`
          );
          continue;
        }

        // Update local record
        await ctx.runMutation(
          internal.communications.graphSubscriptionQueries.updateSubExpiry,
          {
            id: sub._id,
            expiresAt: new Date(newExpiry).getTime(),
          }
        );

        console.log(
          `[Graph Subscriptions] Renewed ${sub.subscriptionId} until ${newExpiry}`
        );
      } catch (err: any) {
        console.error(
          `[Graph Subscriptions] Error renewing ${sub.subscriptionId}:`,
          err.message
        );
      }
    }
  },
});

/**
 * Create a new Graph webhook subscription for a recruiter's mailbox.
 * Called when a recruiter account is connected or manually triggered.
 */
export const createMailSubscription = internalAction({
  args: {
    taEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const token = await getGraphToken();
    const notificationUrl = `${process.env.CONVEX_SITE_URL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL}/api/graph-webhook`;

    // Subscription expires in 3 days (max allowed for mail is ~4230 minutes)
    const expirationDateTime = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000
    ).toISOString();

    const res = await fetch(`${GRAPH_BASE}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource: `users/${args.taEmail}/mailFolders/inbox/messages`,
        expirationDateTime,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `[Graph Subscriptions] Failed to create subscription (${res.status}): ${errorText}`
      );
    }

    const data = await res.json();

    // Persist subscription record
    await ctx.runMutation(
      internal.communications.graphSubscriptionQueries.insertSub,
      {
        subscriptionId: data.id,
        taEmail: args.taEmail,
        resource: `users/${args.taEmail}/mailFolders/inbox/messages`,
        expiresAt: new Date(data.expirationDateTime).getTime(),
      }
    );

    console.log(
      `[Graph Subscriptions] Created subscription ${data.id} for ${args.taEmail}`
    );
    return data.id;
  },
});
