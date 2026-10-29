import { NextRequest, NextResponse } from "next/server";
import { bridgeSecretOk } from "@/lib/claudeBridge";
import { askCvVision, CV_VISION_MAX_BYTES, readCvVisionRequest } from "@/lib/claudeCvVision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_BODY = Math.ceil(CV_VISION_MAX_BYTES / 3) * 4 + 1024;

export async function POST(req: NextRequest) {
  if (!bridgeSecretOk(req.headers.get("x-c141-secret"))) return new NextResponse("Not found", { status: 404 });
  if (Number(req.headers.get("content-length")) > MAX_BODY || !req.body) return new NextResponse("Too large", { status: 413 });
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); return new NextResponse("Too large", { status: 413 }); }
    chunks.push(value);
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return new NextResponse("Invalid request", { status: 400 }); }
  const file = readCvVisionRequest(input);
  if (!file) return new NextResponse("Invalid document", { status: 400 });
  const text = await askCvVision(file);
  return text ? NextResponse.json({ ok: true, text }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
