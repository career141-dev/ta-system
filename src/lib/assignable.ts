import type { User } from "@/data/types";
import { isTa } from "@/lib/auth";

/**
 * Who an opening can be assigned to: active TAs, and nobody else.
 *
 * Leads and admins used to be listed too. They manage the work rather than
 * recruit on it, and a lead picking themselves by mistake left an opening
 * with no recruiter. One list, used by every screen that assigns an opening
 * and by the save that checks it.
 */
export function assignableTas(users: User[]): User[] {
  return users.filter((u) => u.isActive && isTa(u)).sort((a, b) => a.name.localeCompare(b.name));
}
