import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { primeStore } from "@/data/prime";
import { markTablesStale } from "@/data/primeState";
import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import { currentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { convexMutation, convexQuery, internalUploadUrl } from "@/lib/convexServer";
import { PROOF_MAX_BYTES, checkProofUpload, mayAttachProof, mayOpenProof } from "@/lib/strategyProof";

/**
 * The proof picture on a strategy row (8 Oct).
 *
 * POST attaches one to a row the signed-in TA is on. GET serves one back: to a
 * TA lead or director once the TA has submitted, and to the TA who attached it
 * always. A route, not a server action, because a screenshot is bigger than an
 * action's 1 MB body. The picture is stored in Convex storage; the row keeps
 * only its id. Never sent from the storage address: it is fetched here and
 * passed on with a type this code chose, not the one the uploader claimed.
 */

const answer = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });
const refuse = (message: string, status = 400) => answer({ ok: false, message }, status);

export async function POST(req: NextRequest) {
  // The size before the body is read, so an oversized upload is refused unread.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > PROOF_MAX_BYTES + 64 * 1024) return refuse("That picture is over 5 MB. Save a smaller screenshot and try again.", 413);
  if (!isConvex()) {
    // The test store keeps no files.
    return refuse("Pictures are stored by the backend, which this local build is not connected to.", 501);
  }
  await primeStore({});
  const user = await currentUser();
  if (!user) return refuse("Your session has ended. Sign in again.", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return refuse("The upload could not be read. Try again.");
  const file = form.get("file");
  if (!(file instanceof File)) return refuse("Choose a picture first.");

  // The row says which opening this is, not the form.
  const row = repo.strategyAssignment(String(form.get("rowId") ?? ""));
  if (!row) return refuse("That strategy is no longer on this job's table. Reload the page.", 404);
  await primeStore({ openingId: row.openingId });
  const assignment = repo.assignmentFor(row.openingId, user.id) ?? null;
  if (!allows(user, "strategy.work", { openingId: row.openingId, assignment }) || !mayAttachProof(user, row)) {
    return refuse("That strategy is not yours to add a picture to.", 403);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkProofUpload({ size: bytes.length, head: bytes.subarray(0, 16), existing: row.proofs.length });
  if (!checked.ok) return refuse(checked.message, checked.status);

  try {
    const url = await convexMutation<string>("ta/strategies:proofUploadUrl", {});
    const put = await fetch(internalUploadUrl(url), {
      method: "POST",
      headers: { "content-type": checked.contentType },
      body: Buffer.from(bytes),
    });
    if (!put.ok) return refuse(`The picture could not be stored (${put.status}). Try again.`, 502);
    const { storageId } = (await put.json()) as { storageId: string };
    const added = repo.addStrategyProof(row.id, {
      id: storageId,
      contentType: checked.contentType,
      size: bytes.length,
      addedAt: Date.now(),
      addedBy: user.id,
      submittedAt: null,
    });
    if (!added) {
      // The row went while the file was going up: do not leave it behind.
      await convexMutation("ta/strategies:proofDelete", { storageId }).catch(() => {});
      return refuse("That strategy is no longer on this job's table. Reload the page.", 404);
    }
    // The loaded tables are behind the picture just attached: re-read them next load.
    markTablesStale();
    revalidatePath(`/openings/${row.openingId}/strategies`);
    return answer({ ok: true, id: storageId });
  } catch (e) {
    console.warn("[strategy proof]", (e as Error).message);
    return refuse("The picture could not be saved. Try again.", 500);
  }
}

export async function GET(req: NextRequest) {
  await primeStore({});
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in to see this picture.", { status: 401 });
  const row = repo.strategyAssignment(req.nextUrl.searchParams.get("row") ?? "");
  const proofId = req.nextUrl.searchParams.get("proof") ?? "";
  // Not found, rather than forbidden, for anyone who may not see it: it does not confirm it exists.
  if (!row || !mayOpenProof(user, row, proofId) || !isConvex()) return new NextResponse("Not found.", { status: 404 });
  const proof = row.proofs.find((p) => p.id === proofId)!;

  try {
    const url = await convexQuery<string | null>("ta/strategies:proofUrl", { storageId: proof.id });
    if (!url) return new NextResponse("Not found.", { status: 404 });
    const res = await fetch(internalUploadUrl(url), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return new NextResponse("Not found.", { status: 404 });
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        // The type this code recorded after reading the file's bytes, never the storage's.
        "content-type": proof.contentType,
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
      },
    });
  } catch {
    return new NextResponse("The picture could not be loaded.", { status: 502 });
  }
}
