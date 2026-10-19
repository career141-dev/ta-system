import { currentUser } from "@/lib/session";
import { convexQuery, internalUploadUrl } from "@/lib/convexServer";
import { primeStore } from "@/data/prime";

export async function GET(request: Request) {
  await primeStore({});
  const user = await currentUser();
  if (!user) return new Response("Please sign in.", { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    const file = await convexQuery<{ url: string | null; name: string }>("ta/dailyEmails:attachment", {
      actorId: user.id, emailId: params.get("email"), attachmentId: params.get("attachment"),
    });
    if (!file.url) return new Response("Attachment not found.", { status: 404 });
    const response = await fetch(internalUploadUrl(file.url), { cache: "no-store" });
    if (!response.ok) return new Response("Attachment unavailable.", { status: 404 });
    return new Response(response.body, { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch { return new Response("Attachment unavailable or access denied.", { status: 403 }); }
}
