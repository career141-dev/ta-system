"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

type Proposal = { token: string; summary: string; details: string[]; link: string };
type Turn = {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  proposal?: Proposal;
  /** pending until the person decides; then what happened */
  decision?: "pending" | "running" | "done" | "cancelled" | "failed";
  choices?: string[];
};

const STARTERS = [
  "How many CVs came in today?",
  "Who's in my follow-up, with numbers?",
  "Where are my sets?",
  "Any interviews coming up?",
];

/** Internal links render as links; anything else stays text. Mirrors lib/deskAssistant `safeLinks`. */
function Rich({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const re = /\[([^\]]{1,120})\]\(([^)\s]{1,300})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const href = m[2];
    out.push(
      href.startsWith("/") && !href.startsWith("//") ? (
        <Link key={k++} href={href} className="font-medium text-brand hover:underline">{m[1]}</Link>
      ) : (
        m[1]
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <p className="whitespace-pre-wrap">{out.map((n, i) => (typeof n === "string" ? n.replace(/\*\*(.+?)\*\*/g, "$1") : n)).map((n, i) => <span key={i}>{n}</span>)}</p>;
}

/**
 * A small "Ask" in the corner. Closed, it is a single quiet button; open, a
 * panel that answers from the records the person can already see.
 */
export function DeskAssistant() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The suggestions page has its own assistant in the same corner.
  if (pathname?.includes("/hh/suggestions")) return null;

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const history = turns.filter((t) => !t.error).map(({ role, text }) => ({ role, text }));
    setTurns((t) => [...t, { role: "user", text }]);
    setQ("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, history }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        type?: "answer" | "proposal" | "question" | "refusal";
        answer?: string;
        error?: string;
        proposal?: Proposal;
        text?: string;
        choices?: string[];
      };
      const reply: Turn =
        body.type === "proposal" && body.proposal
          ? { role: "assistant", text: body.proposal.summary, proposal: body.proposal, decision: "pending" }
          : body.type === "question" || body.type === "refusal"
            ? { role: "assistant", text: body.text ?? "", choices: body.choices }
            : body.answer
              ? { role: "assistant", text: body.answer }
              : { role: "assistant", text: body.error ?? "That didn't work — try again.", error: true };
      setTurns((t) => [...t, reply]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", text: "Couldn't reach the assistant.", error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (index: number, confirm: boolean) => {
    const turn = turns[index];
    if (!turn?.proposal || turn.decision !== "pending") return;
    if (!confirm) {
      setTurns((t) => t.map((x, i) => (i === index ? { ...x, decision: "cancelled" } : x)));
      return;
    }
    setTurns((t) => t.map((x, i) => (i === index ? { ...x, decision: "running" } : x)));
    try {
      const res = await fetch("/api/assistant/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: turn.proposal.token }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; link?: string };
      setTurns((t) => [
        ...t.map((x, i) => (i === index ? { ...x, decision: (body.ok ? "done" : "failed") as Turn["decision"] } : x)),
        { role: "assistant", text: body.ok ? `${body.message}${body.link ? ` [Open](${body.link})` : ""}` : body.message ?? "That didn't go through.", error: !body.ok },
      ]);
      if (body.ok) router.refresh();
    } catch {
      setTurns((t) => t.map((x, i) => (i === index ? { ...x, decision: "failed" } : x)));
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3.5 py-2 text-[12.5px] text-ink-soft shadow-[0_2px_10px_rgba(23,28,24,0.08)] transition-colors hover:border-brand-line hover:text-brand"
        aria-label="Ask the assistant"
      >
        <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
        Ask
      </button>
    );
  }

  return (
    <aside
      className="fixed bottom-5 right-5 z-40 flex h-[min(520px,calc(100vh-120px))] w-[min(360px,calc(100vw-40px))] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_12px_40px_rgba(23,28,24,0.16)]"
      aria-label="Assistant"
    >
      <header className="flex items-center justify-between border-b border-rule px-4 py-2.5">
        <div>
          <p className="text-[13px] font-semibold">Ask</p>
          <p className="text-[11px] text-ink-faint">Answers from the jobs you can see</p>
        </div>
        <button onClick={() => setOpen(false)} className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-tag hover:text-ink" aria-label="Close">
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
        {turns.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-ink-soft">Ask about your jobs, CVs, sets, follow-ups or interviews — or tell it what to do, like “shortlist Thisara” or “Kavindi expected salary 250k”. Nothing changes until you confirm.</p>
            {STARTERS.map((s) => (
              <button key={s} onClick={() => ask(s)} className="w-fit rounded-full border border-rule px-3 py-1 text-left text-[12px] text-ink-soft hover:border-brand-line hover:text-brand">
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ml-8 self-end rounded-xl bg-tag px-3 py-2">{t.text}</div>
            ) : (
              <div key={i} className={`mr-4 ${t.error ? "text-warn" : ""}`}>
                {t.proposal ? (
                  <div className="rounded-xl border border-rule bg-paper px-3 py-2.5">
                    <p className="font-medium">{t.proposal.summary}</p>
                    <ul className="mt-1 flex flex-col gap-0.5 text-[12px] text-ink-soft">
                      {t.proposal.details.map((d, k) => <li key={k}>{d}</li>)}
                    </ul>
                    {t.decision === "pending" ? (
                      <div className="mt-2.5 flex items-center gap-2">
                        <button onClick={() => decide(i, true)} className="rounded-full bg-brand px-3.5 py-1 text-[12px] font-medium text-white hover:opacity-90">Confirm</button>
                        <button onClick={() => decide(i, false)} className="rounded-full border border-rule px-3 py-1 text-[12px] text-ink-soft hover:text-ink">Cancel</button>
                        <Link href={t.proposal.link} className="ml-auto text-[11.5px] text-ink-faint hover:text-brand">View</Link>
                      </div>
                    ) : (
                      <p className="mt-2 text-[11.5px] text-ink-faint">
                        {t.decision === "running" ? "Doing it…" : t.decision === "done" ? "Done" : t.decision === "cancelled" ? "Cancelled — nothing changed" : "Not done"}
                      </p>
                    )}
                  </div>
                ) : (
                  <Rich text={t.text} />
                )}
                {t.choices && t.choices.length > 0 && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    {t.choices.map((c) => (
                      <button key={c} onClick={() => ask(c)} className="w-fit rounded-full border border-rule px-3 py-1 text-left text-[12px] text-ink-soft hover:border-brand-line hover:text-brand">{c}</button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {busy && <p className="text-ink-faint">Looking…</p>}
          <div ref={end} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
        className="flex items-center gap-2 border-t border-rule px-3 py-2.5"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, 600))}
          placeholder="Ask anything…"
          autoFocus
          className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-ink-faint"
        />
        <button disabled={!q.trim() || busy} className="rounded-full bg-brand px-3 py-1 text-[12px] font-medium text-white disabled:opacity-30">Send</button>
      </form>
    </aside>
  );
}
