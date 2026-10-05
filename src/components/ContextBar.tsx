import Link from "next/link";
import { repo } from "@/data/store";
import { CONTEXT_H, HEADER_H } from "@/lib/chrome";
import { StatusMenu, type OpeningStatus } from "./StatusMenu";
import { WorkingStageMenu } from "./WorkingStageMenu";
import { OpeningMenu } from "./OpeningMenu";
import { getCurrentUser } from "@/lib/session";
import { allows } from "@/lib/auth";

/**
 * The persistent identity band: client, position, the TAs on it. It stays put
 * while you move between the stages, so you always know whose role you are in.
 *
 * Set in sentence case, not shouted. A dark bar of all-caps across the full
 * width reads as an alert rather than a label, and this is the one thing on
 * the page nobody needs to act on.
 */
export async function ContextBar({
  openingId,
  crumbs = [],
}: {
  openingId: string;
  crumbs?: string[];
}) {
  const o = repo.opening(openingId);
  const client = o ? repo.client(o.clientId) : null;
  // Rendered by the layout, which may still be resolving a record that has
  // gone. Render nothing rather than throwing inside a shared shell.
  if (!o || !client) return null;
  const tas = o.assignedTaIds.map((t) => repo.user(t)).filter(Boolean);
  const user = await getCurrentUser().catch(() => null);
  // Everyone who works the job has a working stage — admins, directors and
  // leads as well as its TAs (25 Sep). A client seat or a viewer does not.
  const canStage = user ? allows(user, "opening.act", { assignment: repo.assignmentFor(openingId, user.id) }) : false;
  const workingStage = user ? repo.workingStage(openingId, user.id) : "100%";

  return (
    // One line and sticky from 1024px; on a phone it wraps and scrolls away,
    // so it does not take a third of the screen (5 Oct, mobile).
    <div
      className="z-30 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule bg-paper px-4 py-2 sm:px-6 lg:sticky lg:h-[var(--context-h)] lg:flex-nowrap lg:px-8 lg:py-0"
      style={{ top: HEADER_H, ["--context-h" as string]: `${CONTEXT_H}px` }}
    >
      <Link
        href={`/openings/${openingId}`}
        className="flex min-w-0 basis-full items-baseline gap-2.5 hover:underline lg:basis-auto"
      >
        <span className="truncate text-[14px] font-semibold tracking-tight">{o.title}</span>
        <span className="shrink-0 text-[12.5px] text-ink-soft">{client.name}</span>
      </Link>

      {/* Findings 05-07 — reachable from every screen of the opening, by
          whoever is working it. */}
      <StatusMenu openingId={openingId} status={o.status as OpeningStatus} size="small" />
      {canStage && <WorkingStageMenu openingId={openingId} stage={workingStage} size="small" />}

      {crumbs.map((c) => (
        <span key={c} className="flex shrink-0 items-center gap-2.5 text-[12.5px]">
          <span className="text-ink-faint">›</span>
          <span className="text-ink-soft">{c}</span>
        </span>
      ))}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="flex -space-x-1.5">
          {tas.map((t) => (
            <span
              key={t!.id}
              title={t!.name}
              className="grid h-6 w-6 place-items-center rounded-full border border-surface bg-brand text-[9px] font-bold text-white"
            >
              {t!.initials}
            </span>
          ))}
        </div>
        <span className="hidden text-[12px] text-ink-soft sm:inline">
          {tas.map((t) => t!.name.split(" ")[0]).join(", ")}
        </span>
        {/* A lead or above, or a recruiter on this opening — Delete only moves it to the Bin (28 Sep). */}
        {user && allows(user, "opening.manage", { openingId, assignment: repo.assignmentFor(openingId, user.id) ?? null }) && (
          <OpeningMenu openingId={openingId} title={o.title} candidates={repo.applications(openingId).length} />
        )}
      </div>
    </div>
  );
}
