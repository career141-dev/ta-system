import Link from "next/link";

/** A wrong link or a record someone deleted — said plainly, with a way back (28 Sep). */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-[1100px] px-8 py-9">
      <h1 className="text-[18px] font-semibold text-ink">Not found</h1>
      <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-ink-faint">
        This page or record does not exist, or it was deleted. Check the link, or start again from the dashboard.
      </p>
      <Link href="/" className="mt-5 inline-block rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface">
        Go to the dashboard
      </Link>
    </main>
  );
}
