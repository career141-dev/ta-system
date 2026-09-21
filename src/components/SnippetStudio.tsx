"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SnippetStage } from "./SnippetStage";
import { RAIL_TOP } from "@/lib/chrome";
import { inputClass } from "./form";
import {
  BLOCK_LABEL,
  BLOCK_ORDER,
  DEFAULT_LAYOUT,
  LEVELS,
  SNIPPET_FONTS,
  type BlockKey,
  type LevelKey,
  type SnippetFields,
  type SnippetLayout,
  type TextBlock,
} from "@/lib/snippet";

const WEIGHTS = [
  { v: 300, label: "Light" },
  { v: 400, label: "Regular" },
  { v: 500, label: "Medium" },
  { v: 600, label: "Semibold" },
  { v: 700, label: "Bold" },
];

const ALIGN: { v: TextBlock["align"]; d: string }[] = [
  { v: "left", d: "M2 3h12M2 7h8M2 11h11M2 15h7" },
  { v: "center", d: "M2 3h12M4 7h8M2.5 11h11M4.5 15h7" },
  { v: "right", d: "M2 3h12M6 7h8M3 11h11M7 15h7" },
];

/** Which field feeds which block, so picking a block on the card puts its own
 *  words in front of you rather than sending you hunting down a form. */
const FIELD_FOR: Record<BlockKey, (keyof SnippetFields)[]> = {
  levelPill: [],
  industry: ["industry"],
  titleLead: ["jobTitle"],
  titleMain: ["jobTitle"],
  location: ["location"],
  company: ["company"],
  packageLine: ["package"],
  gender: ["gender"],
  bullets: ["bullets"],
  footer: ["email", "mobile"],
};

const FIELD_LABEL: Partial<Record<keyof SnippetFields, string>> = {
  jobTitle: "Job title",
  industry: "Industry",
  location: "Location",
  company: "Company",
  package: "Package",
  gender: "Gender",
  email: "TA email",
  mobile: "TA mobile",
};

function Stepper({
  label, value, onChange, min, max, step = 1, width = 76,
}: {
  label: string; value: number; onChange: (n: number) => void;
  min: number; max: number; step?: number; width?: number;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <label className="flex items-center gap-1.5" title={label}>
      <span className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</span>
      <span className="flex items-center rounded-lg border border-rule bg-surface" style={{ width }}>
        <button
          onClick={() => onChange(clamp(Number((value - step).toFixed(3))))}
          className="w-5 shrink-0 text-[13px] leading-none text-ink-soft hover:text-ink"
          aria-label={`${label} down`}
        >
          −
        </button>
        <input
          type="number"
          value={Number(value.toFixed(2))}
          step={step}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          className="tabular min-w-0 flex-1 border-0 bg-transparent py-1.5 text-center text-[12px] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          onClick={() => onChange(clamp(Number((value + step).toFixed(3))))}
          className="w-5 shrink-0 text-[13px] leading-none text-ink-soft hover:text-ink"
          aria-label={`${label} up`}
        >
          +
        </button>
      </span>
    </label>
  );
}

/**
 * The snippet studio — spec §6.1, rebuilt 12 Sep against the Canva file.
 *
 * One idea holds it together: **click the thing you want to change.** Picking a
 * block on the card brings up that block's own words and its own type controls
 * together, because "which form field is the tan line on the left?" is the
 * question that made the first version tiring. Nothing is retyped — the content
 * arrives from the approved JD — but everything can be moved, resized and
 * re-weighted, since auto-fill against a fixed 1080x1080 card will sometimes
 * run a long package through a pill.
 */
export function SnippetStudio({
  initial,
  reference,
}: {
  initial: SnippetFields;
  /** A Canva export to lay over the card, for checking the render against the
   *  design. Only the dev compare page passes one. */
  reference?: string;
}) {
  const [fields, setFields] = useState<SnippetFields>(initial);
  const [layout, setLayout] = useState<SnippetLayout>(DEFAULT_LAYOUT);
  const [selected, setSelected] = useState<BlockKey | null>("titleMain");
  const [showType, setShowType] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const set = <K extends keyof SnippetFields>(k: K, v: SnippetFields[K]) =>
    setFields((f) => ({ ...f, [k]: v }));

  const patch = useCallback(
    (k: BlockKey, p: Partial<TextBlock>) => setLayout((l) => ({ ...l, [k]: { ...l[k], ...p } })),
    [],
  );

  const onCanvas = useCallback((c: HTMLCanvasElement | null) => {
    canvasRef.current = c;
  }, []);

  // Arrow keys nudge the selection, the way they do in every canvas tool.
  useEffect(() => {
    if (!selected) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const d = e.shiftKey ? 10 : 1;
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d],
      };
      const m = map[e.key];
      if (!m) return;
      e.preventDefault();
      setLayout((l) => ({
        ...l,
        [selected]: { ...l[selected], x: l[selected].x + m[0], y: l[selected].y + m[1] },
      }));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected]);

  const download = async () => {
    const c = canvasRef.current;
    if (!c) return;
    await document.fonts.ready;
    const a = document.createElement("a");
    a.download = `${fields.jobTitle.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-snippet.png`;
    a.href = c.toDataURL("image/png");
    a.click();
  };

  const b = selected ? layout[selected] : null;
  const chip =
    "rounded-lg border border-rule bg-surface px-2 py-1.5 text-[12px] outline-none cursor-pointer";

  return (
    <div className="grid gap-6 lg:grid-cols-[232px_minmax(0,1fr)] lg:items-start">
      {/* ─── rail ──────────────────────────────────────────────────────── */}
      <aside className="flex flex-col gap-5 lg:sticky" style={{ top: RAIL_TOP + 16 }}>
        <section className="rounded-xl border border-rule bg-surface p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Job level
          </h2>
          <p className="mb-3 mt-1 text-[11.5px] text-ink-faint">Sets the card colour and the level tag.</p>
          <div className="grid grid-cols-5 gap-2">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => set("level", l.key as LevelKey)}
                title={l.pill}
                aria-label={l.pill}
                className={`aspect-square rounded-lg border-2 transition-all ${
                  fields.level === l.key ? "scale-105 border-ink" : "border-transparent hover:border-rule-strong"
                }`}
                style={{ background: l.swatch }}
              />
            ))}
          </div>
          <p className="mt-2.5 text-[11.5px] text-ink-soft">
            {LEVELS.find((l) => l.key === fields.level)?.pill}
          </p>
        </section>

        <section className="rounded-xl border border-rule bg-surface p-4">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Show on the card
          </h2>
          <div className="flex flex-col">
            {BLOCK_ORDER.map((k) => (
              <button
                key={k}
                onClick={() => setSelected(k)}
                className={`flex items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[12.5px] transition-colors ${
                  selected === k ? "bg-brand-soft font-medium text-brand" : "text-ink-soft hover:bg-paper"
                }`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-rule"
                  style={{ background: layout[k].color }}
                />
                {BLOCK_LABEL[k]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setLayout(DEFAULT_LAYOUT)}
            className="mt-3 w-full rounded-lg border border-rule py-2 text-[12px] font-medium text-ink-soft transition-colors hover:border-rule-strong hover:text-ink"
          >
            Put everything back on the design
          </button>
        </section>
      </aside>

      {/* ─── card and its editor ───────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-xl border border-rule bg-surface">
          {/* What you clicked, and what it says. */}
          <div className="flex flex-wrap items-end gap-3 px-5 py-4">
            {!selected || !b ? (
              <p className="py-2 text-[12.5px] text-ink-faint">
                Click anything on the card to edit it.
              </p>
            ) : (
              <>
                <span className="mb-2 w-full text-[12px] font-semibold uppercase tracking-wider text-ink-faint">
                  {BLOCK_LABEL[selected]}
                </span>

                {FIELD_FOR[selected].length === 0 && (
                  <p className="mb-2 text-[12.5px] text-ink-soft">
                    Set by the level swatches on the left.
                  </p>
                )}

                {FIELD_FOR[selected].map((f) =>
                  f === "bullets" ? (
                    <label key={f} className="min-w-[280px] flex-1">
                      <span className="mb-1.5 block text-[12px] text-ink-soft">One per line</span>
                      <textarea
                        rows={4}
                        autoFocus
                        value={fields.bullets.join("\n")}
                        onChange={(e) => set("bullets", e.target.value.split("\n"))}
                        className={`${inputClass} leading-relaxed`}
                      />
                    </label>
                  ) : (
                    <label key={f} className="min-w-[220px] flex-1">
                      <span className="mb-1.5 block text-[12px] text-ink-soft">{FIELD_LABEL[f]}</span>
                      <input
                        value={fields[f] as string}
                        onChange={(e) => set(f, e.target.value as never)}
                        className={inputClass}
                      />
                    </label>
                  ),
                )}

                {(selected === "titleLead" || selected === "titleMain") && (
                  <p className="w-full text-[11.5px] text-ink-faint">
                    Use / to split the title over two lines — the part after the last / is shown
                    large. Example: &ldquo;Senior / Software Engineer&rdquo;. Without a /, the last
                    two words go on the large line.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Type controls, folded away until wanted. Most snippets never need
              them: the design is already right, and a row of eight controls on
              top of the content is what made this feel like a settings screen. */}
          {b && selected && (
            <div className="border-t border-rule">
              <button
                onClick={() => setShowType((v) => !v)}
                className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-[12px] font-medium text-ink-soft hover:text-ink"
              >
                Font and position
                <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden="true" className="opacity-60">
                  <path
                    d={showType ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"}
                    fill="none" stroke="currentColor" strokeWidth="1.7"
                    strokeLinecap="round" strokeLinejoin="round"
                  />
                </svg>
                <span className="ml-auto text-[11.5px] font-normal text-ink-faint">
                  Drag the text on the card, or nudge it with the arrow keys
                </span>
              </button>

              {showType && (
                <div className="flex flex-wrap items-center gap-2 border-t border-rule bg-paper/60 px-5 py-3">
                  <select
                    value={b.font}
                    onChange={(e) => patch(selected, { font: e.target.value })}
                    className={chip}
                  >
                    {SNIPPET_FONTS.map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>

                  <Stepper label="Size" value={b.size} onChange={(n) => patch(selected, { size: n })} min={8} max={160} step={0.5} />

                  <select
                    value={b.weight}
                    onChange={(e) => patch(selected, { weight: Number(e.target.value) })}
                    className={chip}
                  >
                    {WEIGHTS.map((w) => (
                      <option key={w.v} value={w.v}>{w.label}</option>
                    ))}
                  </select>

                  <label className="flex h-[30px] w-[34px] cursor-pointer items-center justify-center rounded-lg border border-rule" title="Colour">
                    <input
                      type="color"
                      value={b.color}
                      onChange={(e) => patch(selected, { color: e.target.value })}
                      className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
                    />
                  </label>

                  <div className="flex rounded-lg border border-rule">
                    {ALIGN.map((a) => (
                      <button
                        key={a.v}
                        onClick={() => patch(selected, { align: a.v })}
                        title={a.v}
                        className={`px-2 py-1.5 ${b.align === a.v ? "text-brand" : "text-ink-faint hover:text-ink"}`}
                      >
                        <svg width={16} height={16} viewBox="0 0 16 18" aria-hidden="true">
                          <path d={a.d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => patch(selected, { uppercase: !b.uppercase })}
                    title="Capitals"
                    className={`rounded-lg border px-2.5 py-1.5 text-[11.5px] font-semibold ${
                      b.uppercase ? "border-brand-line bg-brand-soft text-brand" : "border-rule text-ink-faint hover:text-ink"
                    }`}
                  >
                    AA
                  </button>

                  <Stepper label="Line" value={b.lineHeight} onChange={(n) => patch(selected, { lineHeight: n })} min={0.7} max={3} step={0.05} />
                  <Stepper label="Track" value={b.letterSpacing} onChange={(n) => patch(selected, { letterSpacing: n })} min={-0.15} max={0.4} step={0.005} width={84} />

                  <button
                    onClick={() => patch(selected, DEFAULT_LAYOUT[selected])}
                    className="ml-auto text-[12px] font-medium text-brand hover:underline"
                  >
                    Reset this block
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_180px] xl:items-start">
          <SnippetStage
            fields={fields}
            layout={layout}
            selected={selected}
            onSelect={setSelected}
            onChange={(k, p) => patch(k, p)}
            onCanvas={onCanvas}
            reference={reference}
          />

          <div className="flex flex-row items-center gap-3 xl:flex-col xl:items-stretch">
            <button
              onClick={download}
              className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Download image
            </button>
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              Square PNG, 1080 × 1080 px — sized for WhatsApp, Facebook and LinkedIn.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
