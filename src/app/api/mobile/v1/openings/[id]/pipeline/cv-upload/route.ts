import { primeStore } from "@/data/prime";
import { convexMutation, internalUploadUrl } from "@/lib/convexServer";
import { refuse, signedOut } from "@/lib/mobile/respond";
import { HEADHUNT_MAX_BYTES, queueHeadHuntCv } from "@/lib/openings/hhUpload";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The native equivalent of the web's Upload headhunted CV panel. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > HEADHUNT_MAX_BYTES + 64 * 1024) return refuse(413, "That file is over 10 MB. Save a smaller PDF and try again.");
  await primeStore({ openingId: id });
  const user = await currentUser();
  if (!user) return signedOut();
  const form = await req.formData().catch(() => null);
  if (!form) return refuse(400, "The upload could not be read. Try again.");
  const file = form.get("file");
  if (!(file instanceof File)) return refuse(400, "Choose a CV file first.");
  const workLocationId = String(form.get("workLocationId") ?? "") || undefined;
  const result = await queueHeadHuntCv(user, id, workLocationId, file, { convexMutation, internalUploadUrl, put: fetch });
  return result.ok
    ? Response.json({ ok: true, message: `${result.fileName} is being read.`, uploadId: result.id })
    : refuse(result.status, result.message);
}
