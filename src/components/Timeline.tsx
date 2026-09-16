import { repo } from "@/data/store";
import type { PipelineEvent } from "@/data/types";
import { STAGE_LABEL } from "@/data/types";
import { timeAt } from "@/lib/format";
import { Pager } from "./Pager";
import { matchesQuery, slicePage } from "@/lib/paging";

const PAGE_SIZE = 30;

/**
 * Everything that has happened to one application, from the record.
 *
 * The pipeline has been writing an event on every stage change — who moved
 * them, from where to where, why, and whether it was a person, the system, the
 * Director or the client — and nothing displayed it. The tab showed three
 * lines derived from the application's current state, which is not a history:
 * it says where somebody is now and how they got the badge, not what happened.
 *
 * This is the answer to the question a client asks in month three — why was
 * this person dropped, and when — so it has to come from the log, not from a
 * reconstruction.
 */

const ACTOR_TONE: Record<PipelineEvent["actorType"], string> = {
  user: "bg-brand",
  system: "bg-rule-strong",
  director: "bg-[#c9a227]",
  client: "bg-accent",
};

const ACTOR_LABEL: Record<PipelineEvent["actorType"], string> = {
  user: "",
  system: "automatically",
  director: "the Director",
  client: "the client",
};

/** `director_shortlisted` → `Director shortlisted`. */
function label(e: PipelineEvent): string {
  if (e.toStage && e.fromStage) {
    return `${STAGE_LABEL[e.fromStage]} → ${STAGE_LABEL[e.toStage]}`;
  }
  if (e.toStage) return `Moved to ${STAGE_LABEL[e.toStage]}`;
  const words = e.eventType.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function Timeline({
  applicationId,
  createdAt,
  sourcingChannel,
  q = "",
  page = 1,
  pageHref,
}: {
  applicationId: string;
  createdAt: number;
  sourcingChannel: string;
  /** The header search, narrowing the log. */
  q?: string;
  page?: number;
  pageHref?: (page: number) => string;
}) {
  const all = repo.events(applicationId);
  const whoOf = (e: PipelineEvent) =>
    e.actorType === "user" ? (repo.user(e.actorId ?? "")?.name ?? "someone") : ACTOR_LABEL[e.actorType];
  const events = all
    .filter((e) => matchesQuery(q, label(e), e.note, e.eventType, whoOf(e)))
    .sort((a, b) => b.at - a.at);
  const pages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const lastPage = current === pages;

  return (
    <>
    <ol className="flex flex-col gap-3 text-[13px]">
      {events.length === 0 && (
        <li className="text-[12.5px] text-ink-faint">
          {q && all.length > 0
            ? "Nothing in the log matches that search."
            : "Nothing recorded yet — the log starts at the first stage change."}
        </li>
      )}

      {slicePage(events, current, PAGE_SIZE)
        .map((e) => {
          const who = whoOf(e);
          return (
            <li key={e.id} className="flex gap-3">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${ACTOR_TONE[e.actorType]}`} />
              <div className="min-w-0">
                <div className="font-medium">{label(e)}</div>
                {e.note && (
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">{e.note}</div>
                )}
                <div className="mt-0.5 text-[11.5px] text-ink-faint">
                  {timeAt(e.at)} · {who}
                </div>
              </div>
            </li>
          );
        })}

      {/* The one thing that predates the log: how they arrived. */}
      {lastPage && !q && (
      <li className="flex gap-3">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rule-strong" />
        <div>
          <div className="font-medium">Entered the pool via {sourcingChannel}</div>
          <div className="text-[11.5px] text-ink-faint">{timeAt(createdAt)}</div>
        </div>
      </li>
      )}
    </ol>
    {pageHref && <Pager page={current} pageSize={PAGE_SIZE} total={events.length} href={pageHref} />}
    </>
  );
}
