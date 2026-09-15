import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import type { Role } from "@/data/types";

/**
 * Clerk invitations for the People page.
 *
 * The invite is only the door. What someone can DO is the role on their roster
 * entry, which the admin sets before the invite goes out — so the role applies
 * from their very first sign-in, and Clerk holds no authority of its own. The
 * role copied into the invite's metadata is a label for the pending list, not
 * a permission anything reads.
 */

export interface PendingInvite {
  id: string;
  email: string;
  role: string | null;
  createdAt: number;
}

/** Where the invite link lands: this app's own sign-up page. */
async function signupUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3100";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}/signup`;
}

/** Clerk's own reason, in words an admin can act on. */
function clerkReason(e: unknown): string {
  const err = e as { errors?: { code?: string; longMessage?: string; message?: string }[]; message?: string };
  const first = err.errors?.[0];
  if (first?.code === "duplicate_record") return "There is already a pending invite for this address.";
  if (first?.code === "form_identifier_exists") {
    return "This address already has a Clerk account — no invite needed, they can sign in now with the role you set.";
  }
  return first?.longMessage ?? first?.message ?? err.message ?? "Clerk refused the invite.";
}

export async function sendInvite(email: string, role: Role): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const client = await clerkClient();
    await client.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: await signupUrl(),
      publicMetadata: { deskRole: role },
      notify: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: clerkReason(e) };
  }
}

export async function pendingInvites(): Promise<PendingInvite[]> {
  try {
    const client = await clerkClient();
    const list = await client.invitations.getInvitationList({ status: "pending", limit: 100 });
    return list.data.map((i) => ({
      id: i.id,
      email: i.emailAddress,
      role: typeof i.publicMetadata?.deskRole === "string" ? (i.publicMetadata.deskRole as string) : null,
      createdAt: i.createdAt,
    }));
  } catch {
    return [];
  }
}

export interface OffDeskAccount {
  email: string;
  fullName: string;
  oldAppRole: string;
  isActive: boolean;
  duplicates: number;
  /** Has a login on THIS Clerk instance, so can sign in here once given a role. */
  canSignInHere: boolean;
}

/**
 * Accounts that exist (from the older app) but are not on the desk — the
 * reason an address "already has an account" while nobody can see it.
 */
export async function offDeskAccounts(actorId: string): Promise<OffDeskAccount[]> {
  const { isConvex } = await import("@/data/mode");
  if (!isConvex()) return [];
  const { convexQuery } = await import("@/lib/convexServer");
  let rows: Omit<OffDeskAccount, "canSignInHere">[] = [];
  try {
    rows = await convexQuery("ta/users:listOffDeskAccounts", { actorId });
  } catch {
    return [];
  }
  const clerkEmails = new Set<string>();
  try {
    const client = await clerkClient();
    const users = await client.users.getUserList({ limit: 500 });
    for (const u of users.data) for (const e of u.emailAddresses) clerkEmails.add(e.emailAddress.toLowerCase());
  } catch {
    /* Clerk unreachable: show the accounts without the sign-in hint */
  }
  return rows.map((r) => ({ ...r, canSignInHere: clerkEmails.has(r.email) }));
}

export async function revokeInvite(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const client = await clerkClient();
    await client.invitations.revokeInvitation(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: clerkReason(e) };
  }
}
