import Link from "next/link";
import { STAGE_LABEL, type Stage } from "@/data/types";

export function PageHead({
  title, sub, right,
}: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 text-[13px] text-ink-soft">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Card({
  children, className = "",
}: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-rule bg-surface ${className}`}>{children}</div>
  );
}

export function StageChip({ stage }: { stage: Stage }) {
  return (
    <span
      className={`stage-${stage} inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium`}
      style={{ background: "var(--sb)", color: "var(--s)" }}
    >
      {STAGE_LABEL[stage]}
    </span>
  );
}

export function Tier({ tier }: { tier: string }) {
  return (
    <span className="rounded border border-rule-strong px-1 py-px text-[10.5px] font-semibold text-ink-soft">
      {tier}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" | "danger" | "good" }) {
  const color =
    tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : tone === "good" ? "text-brand" : "text-ink";
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[10.5px] uppercase tracking-[0.09em] text-ink-faint">{label}</div>
      <div className={`tabular mt-0.5 text-[19px] font-semibold leading-none ${color}`}>{value}</div>
    </div>
  );
}

export function Tabs({ base, current, tabs }: { base: string; current: string; tabs: { key: string; label: string; count?: number }[] }) {
  return (
    <div className="mb-4 flex gap-0.5 border-b border-rule">
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={t.key === "overview" ? base : `${base}?tab=${t.key}`}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] ${
              active
                ? "border-ink font-semibold text-ink"
                : "border-transparent text-ink-soft hover:border-rule-strong hover:text-ink"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="tabular rounded-full bg-paper px-1.5 py-px text-[10.5px] text-ink-soft">{t.count}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-ink-faint">{children}</div>;
}
