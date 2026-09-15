import type { Health } from "@/lib/health";

const TONE: Record<Health["band"], { text: string; bg: string; bar: string; word: string }> = {
  good: { text: "text-brand", bg: "bg-brand/10 border-brand/20", bar: "bg-brand", word: "On track" },
  slipping: { text: "text-warn", bg: "bg-warn/10 border-warn/20", bar: "bg-warn", word: "Slipping" },
  stuck: { text: "text-danger", bg: "bg-danger/10 border-danger/20", bar: "bg-danger", word: "Stuck" },
};

export function HealthBar({ health }: { health: Health }) {
  const t = TONE[health.band];
  return (
    <section className="mb-7 rounded-xl border border-rule bg-surface p-5 shadow-[0_1px_2px_rgba(23,28,24,0.03)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${t.bg} ${t.text}`}>
            {health.score} · {t.word}
          </span>
          <span className="text-[13px] font-medium text-ink">{health.headline}</span>
        </div>
        <span className="text-[11.5px] text-ink-faint">Role Health</span>
      </div>

      <dl className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {health.parts.map((p) => (
          <div key={p.label} className="rounded-lg bg-paper/60 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-[12px] font-medium text-ink-soft">{p.label}</dt>
              <dd className="tabular text-[12px] font-semibold text-ink">{p.score}</dd>
            </div>
            <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-rule/50">
              <span
                className={`block h-full rounded-full transition-all ${p.score >= 65 ? "bg-brand" : p.score >= 40 ? "bg-warn" : "bg-danger"}`}
                style={{ width: `${Math.max(3, p.score)}%` }}
              />
            </div>
            <div className="mt-1.5 truncate text-[11px] text-ink-faint">{p.note}</div>
          </div>
        ))}
      </dl>
    </section>
  );
}
