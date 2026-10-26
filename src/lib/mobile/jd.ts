import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { allows, isTa } from "@/lib/auth";
import type { JdPayload } from "@/lib/mobile/jdTypes";
import { mayReadOpening } from "@/lib/mobile/openings";
import { CONSENT_TEXT } from "@/lib/intake";

export function mobileJd(user: User, openingId: string): JdPayload | null {
  const opening = repo.opening(openingId);
  if (!opening || !mayReadOpening(user, openingId)) return null;
  const client = repo.client(opening.clientId);
  if (!client) return null;
  const briefs = repo.briefsForOpening(openingId);
  const mine = briefs.filter((row) => row.capturedBy === user.id).at(-1) ?? null;
  const others = briefs
    .filter((row) => row.capturedBy !== user.id && (row.notesMarkdown.trim() || row.transcriptStatus === "ready" && row.transcript?.trim()))
    .map((row) => {
      const author = repo.user(row.capturedBy);
      return {
        id: row.id,
        author: author?.name ?? "Someone on the desk",
        kind: isTa(author) ? "Notes" as const : "Brief" as const,
        body: [row.notesMarkdown.trim(), row.transcriptStatus === "ready" ? row.transcript?.trim() : ""].filter(Boolean).join("\n\n"),
        at: row.capturedAt,
      };
    });
  const first = briefs[0] ?? (opening.briefId ? repo.brief(opening.briefId) : null);
  const extracted = first?.extracted;
  const summary = [
    extracted?.salaryMin ? `Salary ${extracted.currency} ${extracted.salaryMin.toLocaleString()}${extracted.salaryMax ? `–${extracted.salaryMax.toLocaleString()}` : ""}` : extracted?.packageNotes?.trim() ? `Package ${extracted.packageNotes.trim()}` : null,
    extracted?.locations?.length ? `Location ${extracted.locations.join(", ")}` : null,
    extracted?.nationalities?.length ? `${extracted.nationalities.join(", ")} nationals only` : null,
    extracted?.headcount && extracted.headcount > 1 ? `${extracted.headcount} positions` : null,
    extracted?.mustHaves?.length ? `${extracted.mustHaves.length} requirement${extracted.mustHaves.length === 1 ? "" : "s"}` : null,
    extracted?.priorityTier ? `Priority ${extracted.priorityTier.replace(/^P/, "")}` : null,
  ].filter((row): row is string => Boolean(row));
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const canWrite = opening.assignedTaIds.includes(user.id) || allows(user, "opening.manage", { openingId, assignment });
  const requirements = opening.requirements;
  return {
    apiVersion: 1,
    consentText: CONSENT_TEXT,
    context: { openingId, title: opening.title, clientName: client.name },
    status: opening.jdStatus === "approved" ? "approved" : "draft",
    access: {
      canWrite,
      canAmend: canWrite,
      assignedTo: opening.assignedTaIds.map((id) => repo.user(id)?.name).filter((name): name is string => Boolean(name)),
    },
    notes: { mine: mine?.notesMarkdown ?? "", others, extractedSummary: summary },
    document: {
      markdown: opening.jdMarkdown,
      approvedBy: repo.user(opening.jdApprovedBy ?? "")?.name ?? null,
      approvedAt: opening.jdApprovedAt ?? null,
    },
    chat: repo.jdChat(openingId).map((row) => ({
      id: row.id,
      role: row.role,
      body: row.body,
      at: row.at,
      author: row.role === "user" ? repo.user(row.byUserId ?? "")?.name ?? null : null,
      hasVersion: Boolean(row.jdMarkdown),
      failed: Boolean(row.failed),
    })),
    requirements: requirements ? {
      ...requirements,
      editedByName: repo.user(requirements.editedBy ?? "")?.name ?? null,
    } : null,
  };
}
