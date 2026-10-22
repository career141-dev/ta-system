import type { Application, LinkVaultEntry, User } from "@/data/types";
import { rowIsAnotherTas } from "./visibility";

/**
 * Two TAs on one opening may both hold the same LinkedIn person (22 Oct).
 *
 * Refusing the second paste ("already in the table, added by Thushini") let
 * one click claim a candidate the first TA had not even called. The table is
 * where TAs hunt; the claim is the shortlist — whoever puts them on the
 * pipeline first works them, and the backend's shortlist lock refuses the
 * other. A TA still has one row per person: their own, or one a lead added
 * for them, which they can see.
 */
export function rowCountsFor(user: User, addedByDeskWide: (userId: string) => boolean) {
  return (row: Pick<LinkVaultEntry, "addedBy">) => !rowIsAnotherTas(row, user, addedByDeskWide);
}

/** The other TAs who hold this person on the opening, for "also in Thushini's table". */
export function otherHolders(rows: Pick<LinkVaultEntry, "addedBy">[], user: User, addedByDeskWide: (userId: string) => boolean): string[] {
  const mine = rowCountsFor(user, addedByDeskWide);
  return [...new Set(rows.filter((r) => !mine(r)).map((r) => r.addedBy))];
}

/**
 * The pipeline entry a row may show as its own. Once another TA has claimed
 * the person, a second TA's row would read Interested and "In Director
 * Review →" — their EOD workbook too — for someone they never shortlisted. It
 * shows who has them instead. A lead's row keeps showing the TA's progress:
 * leads add people for the TAs to work.
 */
export function rowApplication<A extends Pick<Application, "ownerTaId">>(
  row: Pick<LinkVaultEntry, "addedBy">,
  app: A | null | undefined,
  addedByDeskWide: (userId: string) => boolean,
): { app: A | null; takenBy: string | null } {
  if (!app) return { app: null, takenBy: null };
  if (app.ownerTaId && app.ownerTaId !== row.addedBy && !addedByDeskWide(row.addedBy)) return { app: null, takenBy: app.ownerTaId };
  return { app, takenBy: null };
}
