import { ROLE_LABEL, type LeadNote } from "@/data/types";

/**
 * Who a lead's note came from, as the TA reads it: "TA Lead · Nimal Perera
 * sent this note". The role is the one saved with the note, not the author's
 * role today, so the line stays true after a promotion.
 */
export function noteByline(note: LeadNote, userNames: Record<string, string>): { role: string; name: string } {
  return {
    role: ROLE_LABEL[note.byRole] ?? "Lead",
    name: userNames[note.by] ?? "someone who has left",
  };
}

/** Newest first — the latest word is the one the TA acts on. */
export function newestFirst(notes: LeadNote[] | undefined): LeadNote[] {
  return [...(notes ?? [])].sort((a, b) => b.at - a.at);
}
