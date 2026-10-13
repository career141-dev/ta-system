import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { isDeskWide, isTa } from "@/lib/auth";
import { scopeLinks } from "@/lib/visibility";
import { eyeMarkedItems } from "./eyeMarked";
import { primeStore } from "@/data/prime";

function eyeMarkedRows(openingId: string, user: User) {
  const desk = new Set(repo.users().filter(isDeskWide).map((u) => u.id));
  return scopeLinks(repo.linkVault(openingId), user, (id) => desk.has(id))
    .map(({ row }) => row).filter((r) => r.isEyeMarked);
}

/** A matched profile may have a database CV without an application on this opening yet. */
export async function primeEyeMarked(openingId: string, user: User) {
  await primeStore({ candidateIds: eyeMarkedRows(openingId, user).flatMap((r) => r.candidateId ? [r.candidateId] : []) });
}

export function visibleEyeMarked(openingId: string, user: User) {
  const rows = eyeMarkedRows(openingId, user);
  const candidates = rows.flatMap((r) => {
    const candidate = r.candidateId ? repo.candidate(r.candidateId) : null;
    return candidate ? [candidate] : [];
  });
  return { rows, items: eyeMarkedItems(rows, repo.applications(openingId), candidates, repo.reviewRounds(openingId)) };
}

/** A TA answers for their own sheet; another TA's unfinished work cannot block them. */
export function eyeMarkedForEmail(openingId: string, user: User) {
  if (!isTa(user)) return [];
  const { rows, items } = visibleEyeMarked(openingId, user);
  const mine = new Set(rows.filter((r) => r.addedBy === user.id).map((r) => r.id));
  return items.filter((item) => mine.has(item.id));
}
