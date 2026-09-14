import Link from "next/link";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { PIPELINE_STAGES, STAGE_LABEL } from "@/data/types";

/**
 * The Director's view — spec §13: agency-wide health, client by client, and the
 * queue of sets waiting on him. Money is here because it is the only screen
 * where it belongs; a recruiter's day is not improved by seeing it.
 */
export function DirectorDashboard() {
  const clients = repo.clients();
  const openings = repo.openings();
  const open = openings.filter((o) => o.status === "open");

  const waiting = open.flatMap((o) =>
    repo.applications(o.id).filter((a) => a.stage === "director_review").map((a) => ({ o, a })),
  );

  const totals = PIPELINE_STAGES.map((s) => ({
    stage: s,
    n: open.reduce((sum, o) => sum + (stageCounts(o.id)[s] ?? 0), 0),
  }));
  const widest = Math.max(...totals.map((t) => t.n), 1);

  const value = open.reduce((n, o) => n + (o.valueOnProgressing ?? 0), 0);
  const placed = openings.reduce((n, o) => n + (o.valueOfPlacement ?? 0), 0);

  return (
    <>
      <section className="mb-8 grid gap-4 sm:grid-cols-4">
        {[
          { n: open.length, label: "Open roles" },
          { n: waiting.length, label: "Waiting on you", warn: waiting.length > 0 },
          { n: `$${Math.round(value / 1000)}k`, label: "In progress" },
          { n: placed ? `$${Math.round(placed / 1000)}k` : "—", label: "Placed" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-rule bg-surface px-6 py-5">
            <div className={`tabular text-[26px] font-semibold leading-none ${s.warn ? "text-warn" : ""}`}>
              {s.n}
            </div>
            <div className="mt-2 text-[12.5px] text-ink-soft">{s.label}</div>
          </div>
        ))}
      </section>

      {waiting.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3.5 text-[13px] font-semibold">Sets waiting on your review</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            <div className="divide-y divide-rule">
              {waiting.slice(0, 10).map(({ o, a }) => {
                const c = repo.candidate(a.candidateId);
                return (
                  <Link
                    key={a.id}
                    href={`/openings/${o.id}/pipeline/director_review`}
                    className="flex flex-wrap items-center gap-x-5 gap-y-1 px-7 py-3.5 hover:bg-paper/60"
                  >
                    <div className="min-w-[220px] flex-1">
                      <p className="text-[13.5px] font-medium">{c?.fullName}</p>
                      <p className="text-[11.5px] text-ink-faint">
                        {repo.client(o.clientId)?.name} · {o.title}
                        {a.setNumber ? ` · set ${a.setNumber}` : ""}
                      </p>
                    </div>
                    <span className="text-[12px] text-ink-soft">
                      {repo.user(a.ownerTaId ?? "")?.name}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">Where everyone is</h2>
          <div className="rounded-2xl border border-rule bg-surface px-7 py-5">
            {totals.map((t) => (
              <div key={t.stage} className="flex items-center gap-4 border-b border-rule py-3 last:border-b-0">
                <span className="w-[130px] shrink-0 text-[13px]">{STAGE_LABEL[t.stage]}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-tag">
                  <div className="h-full bg-brand" style={{ width: `${(t.n / widest) * 100}%` }} />
                </div>
                <span className="tabular w-8 text-right text-[13px] text-ink-soft">{t.n}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3.5 text-[13px] font-semibold">By client</h2>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            <div className="divide-y divide-rule">
              {clients.map((cl) => {
                const mine = open.filter((o) => o.clientId === cl.id);
                const sets = mine.reduce(
                  (n, o) => n + setsForOpening(o.id).filter((s) => s.status === "closed").length,
                  0,
                );
                const v = mine.reduce((n, o) => n + (o.valueOnProgressing ?? 0), 0);
                return (
                  <div key={cl.id} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-7 py-3.5">
                    <div className="min-w-[140px] flex-1">
                      <p className="text-[13.5px] font-medium">{cl.name}</p>
                      <p className="text-[11.5px] text-ink-faint">
                        {mine.length} open
                      </p>
                    </div>
                    <span className="tabular text-[12.5px] text-ink-soft">{sets} sets</span>
                    <span className="tabular w-[64px] text-right text-[12.5px]">
                      {v ? `$${Math.round(v / 1000)}k` : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
