"use server";

import { randomUUID } from "node:crypto";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { safeErrorMessage } from "@/lib/userError";

/**
 * Voice agent → a practice screening call, as the CV platform's "Aura voice
 * agent" page does: the TA types a role and its JD, and talks to the agent in
 * the browser as if they were the candidate.
 *
 * The room carries the same metadata the CV platform's agent reads
 * (candidateName, companyName, jobTitle, jobDescription, detailsToCollect), so
 * the agent already running on that voice server joins and screens against
 * it. It is also dispatched by name, so the TA System's own Aura worker
 * (voice-agent/) can serve it where that is the one running. Nothing is
 * written to any candidate: it is practice.
 */

export type VoiceTestInput = {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  detailsToCollect: string[];
};

export type VoiceTestStart =
  | { ok: true; url: string; token: string; roomName: string }
  | { ok: false; message: string };

const AURA_AGENT_NAME = (process.env.AURA_AGENT_NAME ?? "").trim() || "career141-aura";

function livekitConfig() {
  const server = (process.env.LIVEKIT_URL ?? "").trim();
  const key = (process.env.LIVEKIT_API_KEY ?? "").trim();
  const secret = (process.env.LIVEKIT_API_SECRET ?? "").trim();
  if (!server || !key || !secret) return null;
  const http = server.replace(/^ws(s?):\/\//, "http$1://");
  const browser =
    (process.env.LIVEKIT_BROWSER_URL ?? "").trim() ||
    http.replace(/^http(s?):\/\//, "ws$1://").replace("://127.0.0.1", "://localhost");
  return { http, browser, key, secret };
}

export async function startVoiceTest(input: VoiceTestInput): Promise<VoiceTestStart> {
  // Who is asking is read from the desk roster, so the store has to be loaded
  // in this request too — a server action does not inherit the page's.
  await primeStore();
  const user = await getCurrentUser();
  const allowed = can(user, "voice.practice");
  if (!allowed.ok) return { ok: false, message: allowed.message };
  const companyName = input.companyName.trim().slice(0, 140);
  const jobTitle = input.jobTitle.trim().slice(0, 160);
  const jobDescription = input.jobDescription.trim().slice(0, 4000);
  const detailsToCollect = input.detailsToCollect.map((d) => d.trim().slice(0, 300)).filter(Boolean).slice(0, 15);
  if (!companyName || !jobTitle) return { ok: false, message: "Add the company and the job title." };
  if (jobDescription.length < 20) return { ok: false, message: "Add the job description (at least a couple of lines)." };
  if (detailsToCollect.length === 0) return { ok: false, message: "Add at least one detail for the agent to collect." };

  const lk = livekitConfig();
  if (!lk) return { ok: false, message: "The voice server is not set up yet (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)." };

  const sessionId = randomUUID();
  const roomName = `aura-${sessionId.replace(/-/g, "").slice(0, 12)}`;
  const metadata = JSON.stringify({
    schemaVersion: 1,
    sessionId,
    agentType: "aura-screening",
    mode: "simulation",
    candidateName: input.candidateName.trim().slice(0, 100) || "Candidate",
    companyName,
    jobTitle,
    jobDescription,
    detailsToCollect,
    recruiterUserId: user.id,
    createdAt: new Date().toISOString(),
  });

  try {
    await new RoomServiceClient(lk.http, lk.key, lk.secret).createRoom({
      name: roomName,
      metadata,
      emptyTimeout: 120,
      departureTimeout: 30,
      maxParticipants: 4,
    });
  } catch (e) {
    return { ok: false, message: safeErrorMessage(e, "The voice service could not be reached. Try again.") };
  }
  // For the TA System's own worker, which joins only rooms it is sent to. The
  // CV platform's agent joins every new room without it; a failure here is not
  // a failed call.
  await new AgentDispatchClient(lk.http, lk.key, lk.secret)
    .createDispatch(roomName, AURA_AGENT_NAME, { metadata })
    .catch(() => undefined);

  const token = new AccessToken(lk.key, lk.secret, {
    identity: `recruiter-${user.id}`.slice(0, 60) + `-${sessionId.slice(0, 6)}`,
    name: user.name,
    metadata,
    ttl: "20m",
  });
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  return { ok: true, url: lk.browser, token: await token.toJwt(), roomName };
}
