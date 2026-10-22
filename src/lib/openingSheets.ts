import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { isDeskWide, seesEveryTaRow } from "@/lib/auth";
import { NO_SHEET, levelLabel } from "@/lib/linkViews";

/**
 * The L's this person started under Excel Tables, with how many rows each
 * holds — the same sheets and counts as the table's tabs (22 Oct). A lead's
 * are their own, opened under their name; every TA's L's together were
 * several people's L1 under one number. Shared by the web sidebar
 * (openings/[id]/layout.tsx) and the phone's opening screen, so the two
 * cannot drift apart. Openings with work locations keep their sheets on the
 * table, per location; the sidebar lists none for them.
 */
export function ownSheets(openingId: string, user: User, canSeeSourcing: boolean): { n: number; label: string; name: string; count: number; query: string }[] {
  if (!canSeeSourcing) return [];
  const own = isDeskWide(user) || seesEveryTaRow(user) ? `by=${encodeURIComponent(user.id)}&` : "";
  const mine = repo.linkVault(openingId).filter((r) => r.addedBy === user.id && !r.workLocationId);
  const sheets = repo.linkLevels(openingId, user.id).map((l) => ({
    n: l.n,
    label: levelLabel(l),
    name: l.name ?? "",
    count: mine.filter((r) => r.level === l.n).length,
    query: `${own}level=${l.n}`,
  }));
  const noSheet = mine.filter((r) => !(r.level && r.level > 0)).length;
  if (noSheet > 0) sheets.push({ n: NO_SHEET, label: "Not in a sheet", name: "", count: noSheet, query: `${own}level=none` });
  return sheets;
}
