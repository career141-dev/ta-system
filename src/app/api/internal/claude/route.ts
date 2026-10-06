import { NextRequest, NextResponse } from "next/server";
import { askBridge, bridgeSecretOk, readBridgeRequest } from "@/lib/claudeBridge";

/**
 * The backend's way to the Claude subscription for matching (lib/claudeBridge,
 * 5 Oct). Called over the private docker network by convex/lib/claudeFirst.
 *
 * Only a caller holding C141_CLAUDE_BRIDGE_SECRET, in the `x-c141-secret`
 * header, gets an answer; unset, the route does not exist (404). The address
 * is reachable from outside too, so the secret is the lock, not the network.
 *
 * Every refusal after the secret is a 503, which the backend reads as "ask
 * DeepSeek instead".
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!bridgeSecretOk(req.headers.get("x-c141-secret"))) {
    return new NextResponse("Not found", { status: 404 });
  }
  const r = readBridgeRequest(await req.json().catch(() => null));
  if ("error" in r) return NextResponse.json({ ok: false, reason: r.error }, { status: 400 });
  const answer = await askBridge(r);
  return NextResponse.json(answer, { status: answer.ok ? 200 : 503 });
}
