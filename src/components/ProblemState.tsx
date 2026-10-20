import Link from "next/link";
import { BackButton } from "./BackButton";

export function ProblemState({
  title,
  message,
  primaryHref = "/",
  primaryLabel = "Go to dashboard",
  showBack = true,
  children,
}: {
  title: string;
  message: string;
  primaryHref?: string;
  primaryLabel?: string;
  showBack?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-[760px] px-4 py-10 sm:px-8 sm:py-14">
      <section className="rounded-xl border border-rule bg-surface px-6 py-8 sm:px-8">
        <h1 className="text-[19px] font-semibold text-ink">{title}</h1>
        <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-ink-soft">{message}</p>
        {children}
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={primaryHref} className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
            {primaryLabel}
          </Link>
          {showBack && <BackButton />}
        </div>
      </section>
    </main>
  );
}

