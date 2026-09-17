import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { VoiceTestPanel } from "@/components/voice/VoiceTestPanel";

export const dynamic = "force-dynamic";

/**
 * Voice agent — talk to the AI screening agent about a role before it calls
 * anyone: pick an opening (or type one), and the agent interviews whoever is
 * at this microphone as the candidate.
 */
export default async function VoicePage() {
  await primeStore();
  await getCurrentUser();
  const clients = new Map(repo.clients().map((c) => [c.id, c.name]));
  const openings = repo
    .openings()
    .filter((o) => o.status === "open")
    .map((o) => ({
      id: o.id,
      label: `${clients.get(o.clientId) ?? "—"} — ${o.title}`,
      companyName: clients.get(o.clientId) ?? "",
      jobTitle: o.title,
      jobDescription: (o.jdMarkdown ?? "").slice(0, 4000),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <main className="mx-auto w-full max-w-[1180px] px-8 py-8">
      <h1 className="text-[21px] font-semibold tracking-tight">Voice agent</h1>
      <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-soft">
        Talk to the AI screening agent the way a candidate would. Choose an opening or type a role, then start the
        call — the agent asks about the job and the details below, and you answer out loud. It is practice: nothing is
        saved to any candidate.
      </p>
      <VoiceTestPanel openings={openings} />
    </main>
  );
}
