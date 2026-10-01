// convex/lib/sameCandidate.ts — which existing candidate an arriving CV is (1 Oct).
// Kept apart from candidates.ts so the rule is tested on its own (tests/samecandidate).

import { linkedinVariants, namesAgree, phoneKey, profileSlug } from "./samePerson";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * The candidate an arriving CV belongs to, if we already hold them — or null,
 * and the CV is a new person (1 Oct).
 *
 * A second record for one person is untidy; one person's CV on another's
 * record is wrong, and it was happening: any one shared field merged two
 * people, so an agency's phone on a scoop CV, a referee's email or a company
 * switchboard joined strangers. Proof now, strongest first:
 *   1. the same CV file;
 *   2. the same LinkedIn profile;
 *   3. an email or phone that exactly one person holds, AND names that agree
 *      (convex/lib/samePerson namesAgree). A CV with no name is never merged
 *      on a contact detail alone.
 */
export async function findSameCandidate(
  ctx: any,
  incoming: { fullName?: string | null; email?: string | null; phone?: string | null; linkedinUrl?: string | null; fileHash?: string | null },
  excludeId?: Id<"candidates">,
): Promise<Doc<"candidates"> | null> {
  const usable = (c: Doc<"candidates"> | null | undefined): c is Doc<"candidates"> =>
    !!c && c._id !== excludeId && !c.mergedInto && !c.isDuplicateOf;
  const byIndex = async (index: string, field: string, value: string): Promise<Doc<"candidates">[]> =>
    ((await ctx.db.query("candidates").withIndex(index, (q: any) => q.eq(field, value)).take(5)) as Doc<"candidates">[]).filter(usable);

  if (incoming.fileHash) {
    const [same] = await byIndex("by_fileHash", "fileHash", incoming.fileHash);
    if (same) return same;
  }
  const slug = profileSlug(incoming.linkedinUrl);
  if (slug) {
    for (const url of linkedinVariants(slug)) {
      const [same] = await byIndex("by_linkedinUrl", "linkedinUrl", url);
      if (same) return same;
    }
  }

  // Each contact detail counts only if one person holds it: a number on two
  // records is an office line or an agency's, not anyone's own.
  const holders: Doc<"candidates">[][] = [];
  const email = (incoming.email ?? "").trim();
  if (email.includes("@")) {
    const found = new Map<string, Doc<"candidates">>();
    for (const e of new Set([email, email.toLowerCase()])) for (const c of await byIndex("by_email", "email", e)) found.set(c._id, c);
    holders.push([...found.values()]);
  }
  const pk = phoneKey(incoming.phone);
  if (pk) {
    const found = new Map<string, Doc<"candidates">>();
    for (const p of [pk, `0${pk}`, `94${pk}`]) for (const c of await byIndex("by_phoneClean", "phoneClean", p)) found.set(c._id, c);
    holders.push([...found.values()]);
  }
  for (const list of holders) {
    if (list.length === 1 && namesAgree(incoming.fullName, list[0].fullName)) return list[0];
  }
  return null;
}
