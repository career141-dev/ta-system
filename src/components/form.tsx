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

  // "SAP, IFRS; Excel" typed or pasted is three entries, not one.
  const add = (v: string) => {
    const next = [...tokens];
    for (const part of v.split(/[,;\n]+/)) {
      const t = part.trim();
      if (t && !next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    }
    setTokens(next);
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
          onChange={(e) => {
            // A paste with commas in it is split at once, rather than waiting for Enter.
            if (/[,;\n]/.test(e.target.value)) add(e.target.value);
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === ";") {
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

/** Client choice is a visual pick with instant search and scrollable grid —
 *  showing a clean 2x2 view (max 4 visible without scrolling) so the form
 *  stays compact and well-proportioned. */
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
  const [query, setQuery] = useState("");

  const setValue = (v: string) => {
    setValueState(v);
    onChange?.(v);
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? clients.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.industry.toLowerCase().includes(q),
      )
    : clients;

  const selectedClient = clients.find((c) => c.id === value);

  return (
    <div className="space-y-3">
      <input type="hidden" name={name} value={value} required />

      {/* Search Bar + Selected Client Indicator */}
      <div className="flex items-center gap-2.5">
        <div className="relative flex-1">
          <svg
            width={14}
            height={14}
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
          >
            <path
              d="M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12ZM19 19l-4.35-4.35"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search client name or industry..."
            className="w-full rounded-lg border border-rule bg-surface pl-8.5 pr-8 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand focus:ring-[3px] focus:ring-brand/12"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-ink-faint hover:bg-tag hover:text-ink text-[13px]"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {selectedClient && (
          <div className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-brand/20 bg-brand-soft px-2.5 py-1.5 text-[12px] text-brand">
            <span className="text-[10.5px] uppercase font-semibold tracking-wider text-brand/70">Selected:</span>
            <span className="font-medium max-w-[130px] truncate">{selectedClient.name}</span>
          </div>
        )}
      </div>

      {/* Scrollable client grid (constrained height: exactly 4 cards / 2 rows visible) */}
      {filtered.length > 0 ? (
        <div className="max-h-[124px] overflow-y-auto pr-1">
          <div className="grid gap-2 sm:grid-cols-2">
            {filtered.map((c) => {
              const on = c.id === value;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setValue(c.id)}
                  className={`h-[58px] flex flex-col justify-center rounded-xl border px-3.5 text-left transition-all ${
                    on
                      ? "border-brand bg-brand-soft ring-[3px] ring-brand/10 shadow-sm"
                      : "border-rule bg-surface hover:border-rule-strong hover:bg-paper/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`block truncate text-[13px] ${
                        on ? "font-semibold text-brand" : "font-medium text-ink"
                      }`}
                    >
                      {c.name}
                    </span>
                    {on && (
                      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand text-[9.5px] text-white">
                        ✓
                      </span>
                    )}
                  </div>
                  <span className="mt-0.5 block text-[11px] text-ink-faint truncate">{c.industry}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-rule py-5 text-center">
          <p className="text-[12.5px] text-ink-soft">
            No clients match &ldquo;<span className="font-medium text-ink">{query}</span>&rdquo;
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="mt-1.5 text-[11.5px] font-medium text-brand hover:underline"
          >
            Show all clients ({clients.length})
          </button>
        </div>
      )}
    </div>
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
