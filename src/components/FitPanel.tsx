import type { Score } from "@/lib/scoring";

const TONE: Record<Score["band"], string> = {
  strong: "border-brand-line bg-brand-soft text-brand",
  "worth a look": "border-warn/35 bg-warn-soft text-warn",
  weak: "border-rule bg-tag text-ink-soft",
};

/**
 * The score, and why it is that number.
 *
 * The live system shows a figure and a sentence. A figure alone tells a TA
 * nothing they can act on — Title 100, Skills 20 says the CV uses different
 * words for the same work, which is a reason to rewrite the search rather than
 * reject the person. So the parts are shown, weighted as they were counted.
 */
export function FitPanel({ score }: { score: Score }) {
  const parts: [string, number, number][] = [
    ["Title", score.breakdown.title, score.weights.title],
    ["Skills", score.breakdown.skills, score.weights.skills],
    ["Seniority", score.breakdown.seniority, score.weights.seniority],
    ["Experience", score.breakdown.experience, score.weights.experience],
    ["Industry", score.breakdown.industry, score.weights.industry],
  ];

  return (
    <section className="rounded-xl border border-rule bg-surface px-5 py-4">
      <div className="mb-3.5 flex flex-wrap items-baseline gap-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          Fit against this role
        </span>
        <span className={`ml-auto rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${TONE[score.band]}`}>
          {score.overall} · {score.band}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {parts.filter(([, , w]) => w > 0.02).map(([label, value, weight]) => (
          <div key={label} className="grid grid-cols-[88px_minmax(0,1fr)_58px] items-center gap-3">
            <span className="text-[12px] text-ink-soft">{label}</span>
            <span className="relative h-2 rounded-full bg-paper">
              <span
                className={`absolute inset-y-0 left-0 rounded-full ${
                  value >= 85 ? "bg-brand" : value >= 60 ? "bg-warn" : "bg-rule-strong"
                }`}
                style={{ width: `${Math.max(value, 2)}%` }}
              />
            </span>
            <span className="tabular text-right text-[12px]">
              {value}
              <span className="ml-1 text-[10.5px] text-ink-faint">{Math.round(weight * 100)}%</span>
            </span>
          </div>
        ))}
      </div>

      {score.penalties.length > 0 && (
        <ul className="mt-3.5 flex flex-col gap-1 border-t border-rule pt-3">
          {score.penalties.map((p, i) => (
            <li key={i} className="flex items-baseline gap-2 text-[12px] text-ink-soft">
              <span className="tabular w-8 shrink-0 text-right text-danger">
                {p.delta !== 0 ? p.delta : "—"}
              </span>
              {p.label}
            </li>
          ))}
        </ul>
      )}

      {score.missingSkills.length > 0 && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          Nothing on file for {score.missingSkills.slice(0, 4).join(", ")} — which may mean they
          have not done it, or that their CV calls it something else.
        </p>
      )}

      {/* Said plainly, because a score people cannot interrogate is a score
          they either over-trust or ignore. */}
      <p className="mt-3 border-t border-rule pt-2.5 text-[11px] leading-relaxed text-ink-faint">
        Counted from the approved JD and what the CV holds. No model was asked for the number.
      </p>
    </section>
  );
}
