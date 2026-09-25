"use client";

import { useEffect, useState } from "react";

/**
 * A long wait, shown as what is actually happening.
 *
 * Finding profiles to headhunt takes a minute or more — a model reads the JD,
 * dozens of Google searches run, every profile is checked and ranked — and a
 * button that only greyed out read as a page that had stopped (16 September).
 * This names each step as it comes, with its own small scene in the same
 * flat style as the Database home, a moving bar and the seconds so far.
 *
 * The steps are timed to where a real run usually is, not reported by the
 * server: the page is a single form post, so nothing can be streamed back. The
 * last step holds until the answer arrives.
 */

export type LoadingStep = { after: number; title: string; detail: string; scene: SceneName };
export type SceneName = "read" | "search" | "check" | "rank" | "database";

export const SOURCING_STEPS: LoadingStep[] = [
  { after: 0, title: "Reading the job description", detail: "Working out the titles, skills, industry, location and experience to search for.", scene: "read" },
  { after: 8, title: "Searching Google and LinkedIn", detail: "Running many searches at once — by title, by the work itself and by the companies these people work at.", scene: "search" },
  { after: 30, title: "Checking each profile", detail: "Reading what is public about every person found and setting aside anyone who does not fit.", scene: "check" },
  { after: 55, title: "Ranking the best candidates", detail: "Scoring each person against location, years, industry, level and skills. Only the best are kept.", scene: "rank" },
];

export const RESEARCH_STEPS: LoadingStep[] = [
  { after: 0, title: "Searching the client", detail: "Their website, LinkedIn page, head office and who they compete with.", scene: "search" },
  { after: 6, title: "Reading the client's site", detail: "Opening their own pages to see what they actually do.", scene: "read" },
  { after: 14, title: "Searching the competitors", detail: "Finding each competitor's website and LinkedIn page, and reading their site.", scene: "search" },
  { after: 30, title: "Writing it up", detail: "Sorting what was read into the fields, each with where it came from.", scene: "rank" },
];

export const DATABASE_STEPS: LoadingStep[] = [
  { after: 0, title: "Reading your search", detail: "Working out the role, skills, industry, place and years you described.", scene: "read" },
  { after: 4, title: "Searching every CV on file", detail: "Looking by meaning and by the words themselves, at the same time.", scene: "database" },
  { after: 14, title: "Ranking the closest people", detail: "Scoring each CV against what you asked for, best first.", scene: "rank" },
];

/** Database matching for an opening, which runs in the background (MatchingStatus). */
export const MATCHING_STEPS: LoadingStep[] = [
  { after: 0, title: "Reading the job details", detail: "The skills, years, level and location agreed for this job.", scene: "read" },
  { after: 5, title: "Searching every CV on file", detail: "Looking by meaning and by job title across the whole database.", scene: "database" },
  { after: 20, title: "Scoring each person against the job", detail: "Setting aside anyone this client turned down or who is already on it.", scene: "check" },
  { after: 45, title: "Adding the best matches", detail: "They appear in the list below as soon as they are saved.", scene: "rank" },
];

export const REPORT_STEPS: LoadingStep[] = [
  { after: 0, title: "Reading your question", detail: "Working out which records, filters and grouping you are actually asking for.", scene: "read" },
  { after: 4, title: "Building the report", detail: "Checking every field against what the records actually hold, then running it.", scene: "check" },
];

/**
 * Longer than any run takes, even Claude's slowest headhunt followed by the
 * old search behind it. A run past this has died — most often because the app
 * was restarted for a release while it worked (24 Sep: a Suggestions run sat
 * at "Ranking the best candidates" for an hour and a half, counting, after the
 * server it was waiting on had gone). The steps are timed, not reported, so
 * nothing else on this screen can tell.
 */
const GIVE_UP_AFTER_S = 20 * 60;

export function LoadingProgress({
  steps,
  heading,
  note,
  bare = false,
  since,
}: {
  steps: LoadingStep[];
  heading: string;
  /** A line under the steps — how long it usually takes. */
  note?: string;
  /** Inside something that already has a border. */
  bare?: boolean;
  /** When the work started, for a run that began before this page was drawn. */
  since?: number;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = since ?? Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [since]);
  const current = steps.reduce((at, s, i) => (seconds >= s.after ? i : at), 0);
  const step = steps[current];

  return (
    <div role="status" aria-live="polite" className={`${bare ? "" : "rounded-xl border border-rule bg-surface"} px-6 py-7 text-center`}>
      <Scene name={step.scene} key={step.scene} />
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{heading}</p>
      <p className="mt-1.5 text-[16px] font-semibold tracking-tight">{step.title}…</p>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-soft">{step.detail}</p>

      <div className="mx-auto mt-5 h-[3px] w-full max-w-[360px] overflow-hidden rounded-full bg-brand/15">
        <div className="c141-progress h-full w-1/3 rounded-full bg-brand" />
      </div>

      <ol className="mx-auto mt-5 flex max-w-[520px] flex-wrap justify-center gap-x-4 gap-y-1.5 text-[11.5px]">
        {steps.map((s, i) => (
          <li key={s.title} className={`flex items-center gap-1.5 ${i < current ? "text-brand" : i === current ? "font-medium text-ink" : "text-ink-faint"}`}>
            <span
              aria-hidden="true"
              className={`grid h-3.5 w-3.5 place-items-center rounded-full text-[9px] ${
                i < current ? "bg-brand text-white" : i === current ? "border border-brand" : "border border-rule-strong"
              }`}
            >
              {i < current ? "✓" : ""}
            </span>
            {s.title}
          </li>
        ))}
      </ol>

      {seconds >= GIVE_UP_AFTER_S ? (
        <p role="alert" className="mx-auto mt-4 max-w-[52ch] rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[12.5px] leading-relaxed text-warn">
          This has stopped. It has been working for {Math.floor(seconds / 60)} minutes, far longer than it ever takes, so the run
          most likely ended when the system was updated. Reload the page: anything it found is already saved. If nothing is
          there, press the button again.
        </p>
      ) : (
        <p className="tabular mt-4 text-[11.5px] text-ink-faint">
          {seconds}s{note ? ` · ${note}` : ""}
        </p>
      )}
    </div>
  );
}

// ─── scenes ─────────────────────────────────────────────────────────────────
// The Database home's palette: pale green sky, slate, soft grey, brand green.

const SKY = "#eef4f1";
const SLATE = "#2f3d38";
const GREY = "#cfd8d4";
const PAPER = "#f7f8fa";
const GREEN = "#165b42";

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg width={240} height={112} viewBox="0 0 320 150" role="img" aria-label={label} className="c141-scene mx-auto h-[112px] w-[240px]">
      <path d="M40 150 A120 120 0 0 1 280 150 Z" fill={SKY} />
      {children}
    </svg>
  );
}

export function Scene({ name }: { name: SceneName }) {
  if (name === "read") {
    return (
      <Frame label="Reading the job description">
        <rect x="118" y="36" width="84" height="108" rx="6" fill={PAPER} stroke={GREY} strokeWidth="2" />
        <rect x="132" y="52" width="40" height="6" rx="3" fill={SLATE} />
        {[70, 82, 94, 106, 118].map((y, i) => (
          <rect key={y} x="132" y={y} width={i % 2 ? 44 : 56} height="5" rx="2.5" fill={GREY} className="c141-scene-line" style={{ animationDelay: `${i * 0.25}s` }} />
        ))}
        <g className="c141-scene-float">
          <circle cx="206" cy="104" r="17" fill="none" stroke={GREEN} strokeWidth="5" />
          <path d="M218 116 L232 130" stroke={GREEN} strokeWidth="6" strokeLinecap="round" />
        </g>
      </Frame>
    );
  }
  if (name === "search") {
    return (
      <Frame label="Searching Google and LinkedIn">
        <rect x="92" y="44" width="136" height="24" rx="12" fill={PAPER} stroke={GREY} strokeWidth="2" />
        <circle cx="108" cy="56" r="5" fill="none" stroke={SLATE} strokeWidth="2" />
        <rect x="120" y="53" width="60" height="6" rx="3" fill={GREY} className="c141-scene-line" />
        {[80, 102, 124].map((y, i) => (
          <g key={y} className="c141-scene-pop" style={{ animationDelay: `${i * 0.35}s` }}>
            <rect x="92" y={y} width="136" height="16" rx="4" fill={PAPER} />
            <circle cx="104" cy={y + 8} r="5" fill={GREEN} opacity="0.75" />
            <rect x="114" y={y + 5} width={70 - i * 12} height="6" rx="3" fill={GREY} />
          </g>
        ))}
      </Frame>
    );
  }
  if (name === "check") {
    return (
      <Frame label="Checking each profile">
        {[96, 140, 184].map((x, i) => (
          <g key={x} className="c141-scene-pop" style={{ animationDelay: `${i * 0.4}s` }}>
            <rect x={x} y="58" width="40" height="72" rx="5" fill={PAPER} stroke={GREY} strokeWidth="2" />
            <circle cx={x + 20} cy="80" r="9" fill={GREY} />
            <rect x={x + 8} y="96" width="24" height="4" rx="2" fill={GREY} />
            <rect x={x + 11} y="104" width="18" height="4" rx="2" fill={GREY} />
            {i !== 1 ? (
              <g>
                <circle cx={x + 34} cy="60" r="8" fill={GREEN} />
                <path d={`M${x + 30} 60 L${x + 33} 63 L${x + 38} 57`} stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ) : (
              <g>
                <circle cx={x + 34} cy="60" r="8" fill={GREY} />
                <path d={`M${x + 31} 57 L${x + 37} 63 M${x + 37} 57 L${x + 31} 63`} stroke={SLATE} strokeWidth="2" strokeLinecap="round" />
              </g>
            )}
          </g>
        ))}
      </Frame>
    );
  }
  if (name === "database") {
    return (
      <Frame label="Searching the database">
        {[0, 1, 2].map((i) => (
          <g key={i} className="c141-scene-pop" style={{ animationDelay: `${i * 0.3}s` }}>
            <ellipse cx="160" cy={118 - i * 26} rx="44" ry="11" fill={i === 2 ? GREY : "#dde4e1"} />
            <rect x="116" y={118 - i * 26} width="88" height="20" fill={i === 2 ? GREY : "#dde4e1"} />
            <ellipse cx="160" cy={138 - i * 26} rx="44" ry="11" fill={GREY} />
          </g>
        ))}
        <g className="c141-scene-float">
          <circle cx="222" cy="64" r="15" fill="none" stroke={GREEN} strokeWidth="5" />
          <path d="M232 75 L244 87" stroke={GREEN} strokeWidth="6" strokeLinecap="round" />
        </g>
      </Frame>
    );
  }
  // rank
  return (
    <Frame label="Ranking the best candidates">
      {[
        { x: 116, h: 36, place: 2 },
        { x: 142, h: 56, place: 1 },
        { x: 168, h: 26, place: 3 },
      ].map((p, i) => (
        <g key={p.place} className="c141-scene-pop" style={{ animationDelay: `${i * 0.3}s` }}>
          <rect x={p.x} y={150 - p.h} width="26" height={p.h} fill={p.place === 1 ? GREEN : GREY} opacity={p.place === 1 ? 0.85 : 1} />
          <circle cx={p.x + 13} cy={150 - p.h - 16} r="9" fill={p.place === 1 ? SLATE : "#8a9a92"} />
          <rect x={p.x + 4} y={150 - p.h - 6} width="18" height="6" rx="3" fill={p.place === 1 ? SLATE : "#8a9a92"} />
        </g>
      ))}
      <path className="c141-scene-float" d="M226 52 l5 10 11 1.5 -8 7.5 2 11 -10 -5.5 -10 5.5 2 -11 -8 -7.5 11 -1.5 z" fill="#f2c94c" />
    </Frame>
  );
}
