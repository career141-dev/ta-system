"use client";

import { useState } from "react";

/**
 * Form primitives.
 *
 * A native <select> renders OS chrome that no amount of surrounding care can
 * rescue, so every dropdown here is appearance-none with its own indicator.
 * Where a field has five or fewer options it stops being a dropdown at all —
 * a segmented control shows the whole range at once and takes one click
 * instead of two.
 */

export const inputClass =
  "w-full rounded-lg border border-rule bg-surface px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand focus:ring-[3px] focus:ring-brand/12";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        {hint && <span className="text-[11.5px] text-ink-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Select({
  name,
  defaultValue,
  options,
  placeholder,
  required,
}: {
  name: string;
  defaultValue?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="relative">
      <select
        name={name}
        defaultValue={defaultValue ?? ""}
        required={required}
        className={`${inputClass} cursor-pointer appearance-none pr-10`}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg width={14} height={14}
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
      >
        <path
          d="M4 6.5L8 10.5L12 6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** For small, fixed ranges — priority, currency. The whole range stays visible. */
export function Segmented({
  name,
  options,
  defaultValue,
}: {
  name: string;
  options: { value: string; label: string; sub?: string }[];
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <>
      <input type="hidden" name={name} value={value} />
      <div className="inline-flex w-full gap-1 rounded-xl bg-tag p-1">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setValue(o.value)}
              className={`flex-1 rounded-lg px-2.5 py-2 text-center transition-all ${
                active
                  ? "bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
                  : "hover:bg-surface/50"
              }`}
            >
              <span
                className={`block text-[13px] ${active ? "font-semibold text-ink" : "text-ink-soft"}`}
              >
                {o.label}
              </span>
              {o.sub && (
                <span
                  className={`mt-0.5 block text-[10.5px] ${active ? "text-ink-soft" : "text-ink-faint"}`}
                >
                  {o.sub}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Chips instead of a comma-separated string. Typing and pressing enter adds one. */
export function TokenInput({
  name,
  initial,
  placeholder,
  suggestions = [],
}: {
  name: string;
  initial: string[];
  placeholder: string;
  suggestions?: string[];
}) {
  const [tokens, setTokens] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");

  const add = (v: string) => {
    const t = v.trim();
    if (t && !tokens.includes(t)) setTokens([...tokens, t]);
    setDraft("");
  };

  const unused = suggestions.filter((s) => !tokens.includes(s)).slice(0, 4);

  return (
    <>
      <input type="hidden" name={name} value={tokens.join(", ")} />
      <div className="flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-lg border border-rule bg-surface px-2.5 py-2 transition-colors focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/12">
        {tokens.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1.5 rounded-md bg-tag py-1 pl-2.5 pr-1.5 text-[12.5px]"
          >
            {t}
            <button
              type="button"
              onClick={() => setTokens(tokens.filter((x) => x !== t))}
              className="text-ink-faint transition-colors hover:text-ink"
              aria-label={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            }
            if (e.key === "Backspace" && !draft && tokens.length) {
              setTokens(tokens.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
          placeholder={tokens.length ? "" : placeholder}
          className="min-w-[110px] flex-1 bg-transparent px-1 py-0.5 text-[13.5px] outline-none placeholder:text-ink-faint/70"
        />
      </div>
      {unused.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-ink-faint">Common:</span>
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-md border border-rule px-2 py-[3px] text-[11.5px] text-ink-soft transition-colors hover:border-brand-line hover:text-brand"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** People are picked by face and name, not by checkbox. */
export function PeoplePicker({
  name,
  people,
  initial = [],
  onChange,
}: {
  name: string;
  people: { id: string; name: string; initials: string }[];
  initial?: string[];
  onChange?: (v: string[]) => void;
}) {
  const [picked, setPickedState] = useState<string[]>(initial);
  const setPicked = (v: string[]) => {
    setPickedState(v);
    onChange?.(v);
  };

  return (
    <>
      {picked.map((p) => (
        <input key={p} type="hidden" name={name} value={p} />
      ))}
      <div className="flex flex-wrap gap-2">
        {people.map((p) => {
          const on = picked.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                setPicked(on ? picked.filter((x) => x !== p.id) : [...picked, p.id])
              }
              className={`flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 transition-all ${
                on
                  ? "border-brand bg-brand-soft"
                  : "border-rule bg-surface hover:border-rule-strong"
              }`}
            >
              <span
                className={`grid h-6 w-6 place-items-center rounded-full text-[9.5px] font-bold ${
                  on ? "bg-brand text-white" : "bg-tag text-ink-soft"
                }`}
              >
                {p.initials}
              </span>
              <span className={`text-[13px] ${on ? "font-medium text-brand" : "text-ink-soft"}`}>
                {p.name}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Client choice is a visual pick, not a dropdown — there are few of them and
 *  the industry is worth seeing while you choose. */
export function ClientPicker({
  name,
  clients,
  initial,
  onChange,
}: {
  name: string;
  clients: { id: string; name: string; industry: string }[];
  initial?: string | null;
  onChange?: (v: string) => void;
}) {
  const [value, setValueState] = useState(initial ?? "");
  const setValue = (v: string) => {
    setValueState(v);
    onChange?.(v);
  };
  return (
    <>
      <input type="hidden" name={name} value={value} required />
      <div className="grid gap-2 sm:grid-cols-2">
        {clients.map((c) => {
          const on = c.id === value;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setValue(c.id)}
              className={`rounded-xl border px-4 py-3 text-left transition-all ${
                on
                  ? "border-brand bg-brand-soft ring-[3px] ring-brand/10"
                  : "border-rule bg-surface hover:border-rule-strong"
              }`}
            >
              <span className={`block text-[13.5px] ${on ? "font-semibold text-brand" : "font-medium"}`}>
                {c.name}
              </span>
              <span className="mt-0.5 block text-[11.5px] text-ink-faint">{c.industry}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function Stepper({ step }: { step: 1 | 2 }) {
  const steps = ["Capture the brief", "Review and assign"];
  return (
    <div className="mb-8 flex items-center gap-3">
      {steps.map((s, i) => {
        const n = (i + 1) as 1 | 2;
        const done = n < step;
        const now = n === step;
        return (
          <div key={s} className="flex items-center gap-3">
            <div className="flex items-center gap-2.5">
              <span
                className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold transition-colors ${
                  now
                    ? "bg-brand text-white"
                    : done
                      ? "bg-brand-soft text-brand"
                      : "bg-tag text-ink-faint"
                }`}
              >
                {done ? "✓" : n}
              </span>
              <span
                className={`text-[12.5px] ${now ? "font-medium text-ink" : "text-ink-faint"}`}
              >
                {s}
              </span>
            </div>
            {i === 0 && <span className="h-px w-10 bg-rule" />}
          </div>
        );
      })}
    </div>
  );
}
