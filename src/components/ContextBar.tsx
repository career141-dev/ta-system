import Link from "next/link";
import { repo } from "@/data/store";
import { CONTEXT_H, HEADER_H } from "@/lib/chrome";
import { StatusMenu, type OpeningStatus } from "./StatusMenu";
import { WorkingStageMenu } from "./WorkingStageMenu";
import { OpeningMenu } from "./OpeningMenu";
import { getCurrentUser } from "@/lib/session";
import { isDeskWide } from "@/lib/auth";

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
  const workingStage = user ? repo.workingStage(openingId, user.id) : "100%";

  return (
    <div
      className="sticky z-30 flex items-center gap-3 border-b border-rule bg-paper px-8"
      style={{ height: CONTEXT_H, top: HEADER_H }}
    >
      <Link
        href={`/openings/${openingId}`}
        className="flex min-w-0 items-baseline gap-2.5 hover:underline"
      >
        <span className="truncate text-[14px] font-semibold tracking-tight">{o.title}</span>
        <span className="shrink-0 text-[12.5px] text-ink-soft">{client.name}</span>
      </Link>

      {/* Findings 05-07 — reachable from every screen of the opening, by
          whoever is working it. */}
      <StatusMenu openingId={openingId} status={o.status as OpeningStatus} size="small" />
      <WorkingStageMenu openingId={openingId} stage={workingStage} size="small" />

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
        <span className="text-[12px] text-ink-soft">
          {tas.map((t) => t!.name.split(" ")[0]).join(", ")}
        </span>
        {user && isDeskWide(user) && (
          <OpeningMenu openingId={openingId} title={o.title} candidates={repo.applications(openingId).length} />
        )}
      </div>
    </div>
  );
}
