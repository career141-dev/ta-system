import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { convexMutation, convexQuery } from "@/lib/convexServer";

interface NotificationsPayload {
  unreadCount: number;
  notifications: {
    id: string;
    type: string;
    title: string;
    body: string;
    jobId: string | null;
    read: boolean;
    createdAt: string;
  }[];
}

/** The bell's own feed — polled from the client, since nothing here pushes. */
export async function GET() {
  await primeStore({});
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });

  const payload = await convexQuery<NotificationsPayload>("ta/notifications:listForUser", {
    userId: user.id,
    limit: 30,
  });
  return NextResponse.json(payload);
}

/** Mark one notification read (`{id}`), or all of them (`{all: true}`). */
export async function POST(req: Request) {
  await primeStore({});
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  if (body.all === true) {
    await convexMutation("ta/notifications:markAllRead", { userId: user.id });
    return NextResponse.json({ ok: true });
  }
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  await convexMutation("ta/notifications:markRead", { userId: user.id, notificationId: id });
  return NextResponse.json({ ok: true });
}
