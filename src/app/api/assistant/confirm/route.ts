import { primeStore } from "@/data/prime";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/session";
import { execute } from "@/lib/deskActions";

/** Runs a change the person has confirmed in the Ask chat. Checked again in full. */
export async function POST(req: Request) {
  // Load the store before reading it — this route has no page to do it first.
  await primeStore({ allApplications: true, followUps: true });
  const user = await currentUser();
  if (!user || !user.isActive) return Response.json({ ok: false, message: "Sign in first." }, { status: 401 });
  let token = "";
  try {
    token = String(((await req.json()) as { token?: unknown }).token ?? "");
  } catch {
    return Response.json({ ok: false, message: "Could not read the confirmation." }, { status: 400 });
  }
  const r = execute(user, token);
  if (r.ok) {
    revalidatePath("/", "layout");
  }
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
