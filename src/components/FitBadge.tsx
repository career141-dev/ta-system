import { bandFor, type Score } from "@/lib/scoring";

/**
 * The score, as the first thing on the row.
 *
 * Third attempt. It was a boxed number with grey micro-copy, then a card with
 * a ring and bars bolted onto the right-hand side. Both were furniture: a
 * hundred-pixel panel repeated down every row, competing with the candidate
 * for attention when its only job is to tell you whether to read them.
 *
 * So it leads instead. A number in the left gutter with a rule under it in the
 * band's colour, the rank above, and the reason as one readable line beside
 * the title — the list reads as a ranked list, and nothing new is drawn.
 */

const BAND: Record<Score["band"], { rule: string; text: string; word: string }> = {
  strong: { rule: "bg-brand", text: "text-brand", word: "strong" },
  "worth a look": { rule: "bg-warn", text: "text-warn", word: "worth a look" },
  weak: { rule: "bg-rule-strong", text: "text-ink-faint", word: "weak" },
};

/**
 * The left gutter: rank, number, a rule the width of the score.
 *
 * `displayOverall` is set only on the database search and reverse-match
 * screens (lib/scoring.ts `exaggeratedScore`) — the number and the band word
 * both move together, so nothing on screen contradicts itself. Every other
 * screen leaves it unset and shows the real score, unchanged.
 */
export function FitMark({ score, rank, displayOverall }: { score: Score; rank?: number; displayOverall?: number }) {
  const shown = displayOverall ?? score.overall;
  const tone = BAND[displayOverall === undefined ? score.band : bandFor(displayOverall)];
  return (
    <div className="w-[46px] shrink-0 pt-0.5">
      {rank !== undefined && (
        <div className="tabular text-[10.5px] leading-none text-ink-faint">#{rank}</div>
      )}
      <div className="tabular mt-1 text-[22px] font-semibold leading-none tracking-tight">
        {shown}
      </div>
      <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-paper">
        <span
          className={`block h-full rounded-full ${tone.rule}`}
          style={{ width: `${Math.max(6, shown)}%` }}
        />
      </div>
      <div className={`mt-1.5 text-[10.5px] leading-tight ${tone.text}`}>{tone.word}</div>
    </div>
  );
}

/**
 * Why, in one line beside the title — and the whole working under it.
 *
 * The line is the sentence that decides whether a CV gets opened. The working
 * is for the TA who wants to know why this person got 64 and not 80: each part
 * with its evidence, its weight for this kind of job, and the points it put in.
 */
export function FitReason({ score, displayOverall }: { score: Score; displayOverall?: number }) {
  const shown = displayOverall ?? score.overall;
  const gap = score.penalties[0];
  return (
    <div className="mt-1.5">
      <p className="text-[12.5px] leading-[1.6] text-ink-soft">
        {score.reasons[0]}
        {gap && (
          <span className="text-danger">
            {" "}
            {gap.delta} {gap.label.toLowerCase()}.
          </span>
        )}
      </p>
      <details className="group mt-1">
        <summary className="cursor-pointer list-none text-[11.5px] text-ink-faint hover:text-ink-soft">
          <span className="group-open:hidden">Why {shown}?</span>
          <span className="hidden group-open:inline">Hide the working</span>
        </summary>
        <dl className="mt-2 max-w-[560px] divide-y divide-rule border-y border-rule text-[12px]">
          {score.explanation.map((line, i) => (
            <div key={i} className="grid grid-cols-[76px_1fr_34px] gap-x-3 py-1.5">
              <dt className="font-medium">{line.part}</dt>
              <dd className="leading-relaxed text-ink-soft">
                {line.detail}
                {line.score !== null && line.weight !== null && (
                  <span className="tabular whitespace-nowrap text-ink-faint">
                    {" "}· {line.score}/100, weighted {Math.round(line.weight * 100)}%
                  </span>
                )}
              </dd>
              <dd className={`tabular text-right font-medium ${line.points < 0 ? "text-danger" : ""}`}>
                {line.points}
              </dd>
            </div>
          ))}
          <div className="grid grid-cols-[76px_1fr_34px] gap-x-3 py-1.5 font-semibold">
            <dt>Score</dt>
            <dd />
            <dd className="tabular text-right">{score.overall}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

/**
 * The score beside a name in the search results: a ring that fills to the
 * number as the row appears, the number inside, the band beside it. It was
 * 12px text and easy to miss (17 September).
 */
export function FitChip({ score, displayOverall }: { score: Score; displayOverall?: number }) {
  const shown = displayOverall ?? score.overall;
  const tone = BAND[displayOverall === undefined ? score.band : bandFor(displayOverall)];
  const r = 15;
  const len = 2 * Math.PI * r;
  const to = len * (1 - Math.max(0, Math.min(100, shown)) / 100);
  return (
    <span
      className="c141-score-pop tabular inline-flex items-center gap-2 align-middle"
      title={score.reasons.join(" · ")}
    >
      <span className={`relative inline-grid h-[38px] w-[38px] place-items-center ${tone.text}`}>
        <svg width={38} height={38} viewBox="0 0 38 38" aria-hidden="true" className="absolute inset-0 -rotate-90">
          <circle cx="19" cy="19" r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={4} />
          <circle
            cx="19"
            cy="19"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={len}
            strokeDashoffset={to}
            className="c141-score-ring"
            style={{ "--c141-len": `${len}`, "--c141-to": `${to}` } as React.CSSProperties}
          />
        </svg>
        <span className="relative text-[13px] font-bold text-ink">{shown}</span>
      </span>
      <span className={`text-[12px] font-semibold ${tone.text}`}>{tone.word}</span>
    </span>
  );
}
