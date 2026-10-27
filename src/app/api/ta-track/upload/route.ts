import { createHash } from "node:crypto";
import { convexMutation } from "@/lib/convexServer";
import { validateTrackingRows } from "@/lib/taTracking";

export const dynamic = "force-dynamic";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
export function OPTIONS() { return new Response(null, { status: 204, headers }); }
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return reply({ error: "Sign in with your Career141 email in the extension." }, 401);
  let body: { rows: unknown; enabled: boolean };
  try {
    // Bound streamed bodies as well as requests declaring Content-Length.
    const reader = req.body?.getReader();
    if (!reader) return reply({ error: "Missing tracking data." }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 128000) { await reader.cancel(); return reply({ error: "Tracking upload too large." }, 413); }
      chunks.push(chunk.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body.enabled !== "boolean") throw new Error("Invalid tracking status.");
    body.rows = validateTrackingRows(body.rows);
  } catch { return reply({ error: "Invalid tracking data. Reload or update the extension." }, 400); }
  try {
    const result = await convexMutation<{ ok: boolean; name?: string; email?: string }>("ta/tracking:upload", { tokenHash: createHash("sha256").update(token).digest("hex"), rows: body.rows, enabled: body.enabled });
    if (!result.ok) return reply({ error: "Browser sign-in expired or was disconnected. Pause, then start tracking to sign in again." }, 401);
    return reply(result);
  } catch { return reply({ error: "Upload unavailable. Your data stays in this browser and will retry." }, 503); }
}
