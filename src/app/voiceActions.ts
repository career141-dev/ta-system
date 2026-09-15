"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { convexMutation } from "@/lib/convexServer";

/**
 * The AI screening call in a browser room — no SIP trunk needed.
 *
 * The backend records the call and its session (convex/ta/voice.ts); this
 * server holds the LiveKit key, so it creates the room carrying the call's
 * metadata and mints the browser's token. The voice agent joins every new room
 * on the server, reads the metadata, and reports answers back to the backend.
 */

export type WebCallStart =
  | { ok: true; url: string; token: string; roomName: string; aiCallId: string }
  | { ok: false; message: string };

function livekitConfig() {
  const server = (process.env.LIVEKIT_URL ?? "").trim();
  const key = (process.env.LIVEKIT_API_KEY ?? "").trim();
  const secret = (process.env.LIVEKIT_API_SECRET ?? "").trim();
  if (!server || !key || !secret) return null;
  const http = server.replace(/^ws(s?):\/\//, "http$1://");
  // What the browser dials. NEXT_PUBLIC_LIVEKIT_URL is kept for the hosted
  // voice server; the local one is reached on the same host as LIVEKIT_URL.
  const browser =
    (process.env.LIVEKIT_BROWSER_URL ?? "").trim() ||
    http.replace(/^http(s?):\/\//, "ws$1://").replace("://127.0.0.1", "://localhost");
  return { http, browser, key, secret };
}

function backendMessage(e: unknown, fallback: string): string {
  const raw = (e as Error)?.message ?? "";
  return raw.replace(/^.*?Uncaught Error:\s*/s, "").split("\n")[0].slice(0, 200) || fallback;
}

export async function startWebCall(applicationId: string, openingId: string): Promise<WebCallStart> {
  if (!isConvex()) return { ok: false, message: "AI calls need the Convex store." };
  await primeStore({ openingId });
  const user = await getCurrentUser();
  const app = repo.application(applicationId);
  if (!app || app.openingId !== openingId) return { ok: false, message: "That candidate is not on this opening." };
  const decision = can(user, "opening.act", {
    openingId,
    assignment: repo.assignmentFor(openingId, user.id) ?? null,
    ownerTaId: app.ownerTaId,
  });
  if (!decision.ok) return { ok: false, message: decision.message };

  const lk = livekitConfig();
  if (!lk) return { ok: false, message: "LiveKit is not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)." };

  const roomName = `ta-call-${randomUUID()}`;
  const identity = `ta-${user.id}`.slice(0, 120);

  let prepared: { aiCallId: string; callSessionId: string; metadata: Record<string, unknown> };
  try {
    prepared = await convexMutation("ta/voice:prepareWebCall", {
      actorId: user.id,
      applicationId,
      roomName,
      participantIdentity: identity,
    });
  } catch (e) {
    return { ok: false, message: backendMessage(e, "The call could not be prepared.") };
  }

  try {
    const rooms = new RoomServiceClient(lk.http, lk.key, lk.secret);
    await rooms.createRoom({
      name: roomName,
      metadata: JSON.stringify(prepared.metadata),
      emptyTimeout: 120,
      maxParticipants: 4,
    });
    const token = new AccessToken(lk.key, lk.secret, { identity, name: user.name, ttl: "20m" });
    token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return { ok: true, url: lk.browser, token: await token.toJwt(), roomName, aiCallId: prepared.aiCallId };
  } catch (e) {
    await convexMutation("ta/voice:abandonWebCall", {
      actorId: user.id,
      aiCallId: prepared.aiCallId,
      reason: "LiveKit room could not be created",
    }).catch(() => undefined);
    return { ok: false, message: `Could not reach LiveKit: ${(e as Error).message}` };
  }
}

/** Called when the TA leaves. Harmless if the agent already finalized the call. */
export async function endWebCall(aiCallId: string, openingId: string, reason?: string): Promise<void> {
  if (!isConvex()) return;
  const user = await getCurrentUser();
  await convexMutation("ta/voice:abandonWebCall", { actorId: user.id, aiCallId, reason }).catch(() => undefined);
  revalidatePath(`/openings/${openingId}`, "layout");
}
