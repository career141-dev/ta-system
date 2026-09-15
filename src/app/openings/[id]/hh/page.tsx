import Link from "next/link";
import { repo } from "@/data/store";
import { ProjectHeader } from "../ProjectHeader";
import { primeStore } from "@/data/prime";

export default async function HeadhuntingOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  const vault = repo.linkVault(id);
  const eye = vault.filter((v) => v.isEyeMarked);
  const reached = vault.filter((v) => ["cv_received", "shortlisted"].includes(v.outcome));
  const eyeReached = eye.filter((v) => ["cv_received", "shortlisted"].includes(v.outcome));
  const contacted = vault.filter((v) => v.outcome !== "no_contact");

  const next = [
    vault.filter((v) => v.outcome === "no_contact").length > 0 && {
      title: `${vault.filter((v) => v.outcome === "no_contact").length} links not yet approached`,
      sub: "Pasted but no outreach logged against them",
      href: `/openings/${id}/hh/links`,
      action: "Open vault",
    },
    eye.length < 3 && {
      title: `${eye.length} of 3 eye-marked`,
      sub: "The high-conviction profiles this role is measured on",
      href: `/openings/${id}/hh/links`,
      action: "Mark profiles",
    },
    {
      title: "Benchmark not yet chosen",
      sub: "Pick who to benchmark against on Research — it steers the next suggestions round",
      href: `/openings/${id}/hh/research`,
      action: "Choose",
    },
  ].filter(Boolean) as { title: string; sub: string; href: string; action: string }[];

  return (
    <>
      <div className="mb-8 flex items-start justify-between gap-8">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight">Headhunting</h1>
          <ProjectHeader openingId={id} />
        </div>
        <div className="flex shrink-0 gap-9 text-right">
          <div>
            <div className="tabular text-[20px] font-semibold leading-none">{vault.length}</div>
            <div className="mt-1.5 text-[12px] text-ink-soft">Links</div>
          </div>
          <div>
            <div className="tabular text-[20px] font-semibold leading-none">{contacted.length}</div>
            <div className="mt-1.5 text-[12px] text-ink-soft">Approached</div>
          </div>
          <div>
            <div className="tabular text-[20px] font-semibold leading-none">{reached.length}</div>
            <div className="mt-1.5 text-[12px] text-ink-soft">Reached a CV</div>
          </div>
        </div>
      </div>

      <section className="mb-9">
        <h2 className="mb-3 text-[13px] font-medium text-ink-soft">Next</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {next.map((s) => (
            <div key={s.title} className="flex flex-col justify-between rounded-xl border border-rule bg-surface p-5">
              <div>
                <p className="text-[13.5px] font-medium leading-snug">{s.title}</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{s.sub}</p>
              </div>
              <Link href={s.href} className="mt-5 self-end text-[12.5px] font-medium text-brand hover:underline">
                {s.action}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[13px] font-medium text-ink-soft">Eye-mark yield</h2>
        <p className="max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">
          {eye.length === 0
            ? "Nothing eye-marked yet. The two or three profiles that strictly match the brief are the ones worth tracking, because their conversion is the honest measure of sourcing quality."
            : `${eyeReached.length} of ${eye.length} eye-marked profiles reached a CV — ${
                eye.length ? Math.round((eyeReached.length / eye.length) * 100) : 0
              }%. Across all ${vault.length} links the rate is ${
                vault.length ? Math.round((reached.length / vault.length) * 100) : 0
              }%.`}
        </p>
      </section>
    </>
  );
}
