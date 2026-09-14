import type { Health } from "@/lib/health";

/**
 * Whether this role is on track, and what is wrong with it.
 *
 * A score on its own is a number somebody either believes or ignores. The four
 * parts are shown beside it so it can be argued with, and the headline names
 * the worst one — because that is the thing to go and fix.
 */
const TONE: Record<Health["band"], { text: string; bar: string; word: string }> = {
  good: { text: "text-brand", bar: "bg-brand", word: "On track" },
  slipping: { text: "text-warn", bar: "bg-warn", word: "Slipping" },
  stuck: { text: "text-danger", bar: "bg-danger", word: "Stuck" },
};

export function HealthBar({ health }: { health: Health }) {
  const t = TONE[health.band];
  return (
    <section className="mb-6 rounded-xl border border-rule bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`tabular text-[20px] font-semibold leading-none ${t.text}`}>
          {health.score}
        </span>
        <span className={`text-[13px] font-medium ${t.text}`}>{t.word}</span>
        <span className="text-[13px] text-ink-soft">{health.headline}</span>
      </div>

      <dl className="mt-3 grid gap-2 sm:grid-cols-4">
        {health.parts.map((p) => (
          <div key={p.label}>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-[11.5px] text-ink-soft">{p.label}</dt>
              <dd className="tabular text-[11.5px] text-ink-faint">{p.score}</dd>
            </div>
            <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-paper">
              <span
                className={`block h-full rounded-full ${p.score >= 65 ? "bg-brand" : p.score >= 40 ? "bg-warn" : "bg-danger"}`}
                style={{ width: `${Math.max(3, p.score)}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-ink-faint">{p.note}</div>
          </div>
        ))}
      </dl>
    </section>
  );
}
