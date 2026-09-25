"use client";

import { useEffect, useRef, useState } from "react";
import { restoreJdVersionInline, reviseJdInline } from "@/app/actions";
import { JD_REQUEST_MAX } from "@/lib/jdChat";
import { ActionNote, Spinner, useInline } from "./Submit";
import { inputClass } from "./form";

export type JdChatTurn = {
  id: string;
  role: "user" | "assistant";
  body: string;
  at: number;
  /** Who asked, for a request. */
  author: string | null;
  /** This answer produced a JD that can be put back. */
  hasVersion: boolean;
  failed: boolean;
};

function clock(at: number) {
  return new Date(at).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo",
  });
}

/**
 * The JD chat (25 Sep): the TA tells the AI what to change — "add CIMA, drop
 * the driving licence, the package is LKR 450k–500k" — and it rewrites the JD
 * above, as many times as it takes, until the TA approves it.
 *
 * Not a <form>: it sits inside the approval form, between the JD and the
 * Approve button, and a form cannot hold another. Its button sends its own
 * request; approving still sends only the JD.
 */
export function JdChat({
  openingId,
  turns,
  currentJd,
  approved,
}: {
  openingId: string;
  turns: JdChatTurn[];
  /** The JD as it stands in the editor, hand edits included. */
  currentJd: string;
  approved: boolean;
}) {
  const [request, setRequest] = useState("");
  const [sent, setSent] = useState("");
  const revise = useInline(reviseJdInline);
  const restore = useInline(restoreJdVersionInline);
  const busy = revise.pending || restore.pending;
  const end = useRef<HTMLDivElement | null>(null);

  // A request that went through is cleared; one that failed stays to resend.
  useEffect(() => {
    if (revise.result?.ok) setRequest((r) => (r === sent ? "" : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revise.result]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length, revise.pending]);

  const send = () => {
    const text = request.trim();
    if (!text || busy) return;
    const fd = new FormData();
    fd.append("openingId", openingId);
    fd.append("request", text);
    fd.append("currentJd", currentJd);
    setSent(request);
    revise.run(fd);
  };

  const putBack = (messageId: string) => {
    if (busy) return;
    const fd = new FormData();
    fd.append("openingId", openingId);
    fd.append("messageId", messageId);
    restore.run(fd);
  };

  const latestVersion = [...turns].reverse().find((t) => t.hasVersion)?.id;

  return (
    <div className="rounded-xl border border-rule bg-paper/50">
      <div className="border-b border-rule px-5 py-3">
        <h3 className="text-[13px] font-semibold">Ask the AI to change it</h3>
        <p className="mt-0.5 text-[12px] text-ink-soft">
          {approved
            ? "Say what should change. The approved JD is replaced with the revision, and the Job details follow it."
            : "Say what should change and the JD above is rewritten. Ask as many times as you need, then approve."}
        </p>
      </div>

      {turns.length > 0 && (
        <ol className="flex max-h-[340px] flex-col gap-3 overflow-y-auto px-5 py-4">
          {turns.map((t) =>
            t.role === "user" ? (
              <li key={t.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-soft px-3.5 py-2">
                  <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{t.body}</p>
                  <p className="mt-1 text-right text-[10.5px] text-ink-faint">
                    {t.author ? `${t.author} · ` : ""}
                    {clock(t.at)}
                  </p>
                </div>
              </li>
            ) : (
              <li key={t.id} className="flex">
                <div className="max-w-[85%]">
                  <p className={`whitespace-pre-wrap text-[12.5px] leading-relaxed ${t.failed ? "text-danger" : "text-ink-soft"}`}>
                    {t.body}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-faint">
                    {clock(t.at)}
                    {t.hasVersion &&
                      (t.id === latestVersion ? (
                        <span>· the JD above</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => putBack(t.id)}
                          className="font-medium text-brand hover:underline disabled:opacity-50"
                        >
                          · Use this version
                        </button>
                      ))}
                  </p>
                </div>
              </li>
            ),
          )}
          {revise.pending && (
            <li className="flex items-center gap-2 text-[12.5px] text-brand">
              <Spinner tone="dark" /> Rewriting the JD…
            </li>
          )}
          <div ref={end} />
        </ol>
      )}

      <div className="px-5 pb-4 pt-3">
        <label htmlFor={`jd-request-${openingId}`} className="sr-only">
          What should change in the JD
        </label>
        <textarea
          id={`jd-request-${openingId}`}
          rows={3}
          value={request}
          maxLength={JD_REQUEST_MAX}
          disabled={busy}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Enter must never submit the approval form.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="e.g. Add 5 years in FMCG and CIMA, remove the driving licence, the package is LKR 450k–500k."
          className={`${inputClass} leading-[1.7]`}
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={send}
            disabled={busy || !request.trim()}
            aria-busy={revise.pending}
            className="inline-flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
          >
            {revise.pending && <Spinner tone="dark" />}
            {revise.pending ? "Revising…" : "Revise the JD"}
          </button>
          <span className="text-[11.5px] text-ink-faint">Enter to send · Shift+Enter for a new line</span>
        </div>
        {revise.result && !revise.pending && <ActionNote result={revise.result} className="mt-2.5" />}
        {restore.result && !restore.pending && <ActionNote result={restore.result} className="mt-2.5" />}
      </div>
    </div>
  );
}
