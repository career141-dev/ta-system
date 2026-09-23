import { externalUrl } from "@/lib/url";
import { aiStatus, FAILURE_MESSAGE, type AiFailure } from "@/lib/ai";
import { serperConfigured } from "@/lib/serper";
import { GenerateForm } from "./GenerateForm";
import type { ActionResult } from "@/lib/inlineResult";

/**
 * The bar above every generated page — spec §8A.
 *
 * It always says what the system can and cannot currently do. A page that
 * silently produces nothing because a key is missing teaches the desk that the
 * feature is broken; one that names the setting gets fixed in a minute.
 */
export function Generate({
  openingId,
  action,
  label,
  sub,
  err,
  found,
  searches,
  hasResult,
  needs = "grounded",
}: {
  openingId: string;
  action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  label: string;
  sub: string;
  err?: string;
  found?: string;
  searches?: string;
  hasResult: boolean;
  /** What this feature actually depends on, so the message names the real gap.
   *  "search": web search (SearXNG or Serper), then a model to sort what was read. */
  needs?: "grounded" | "sourcing" | "search";
}) {
  const st = aiStatus();
  const missing: string[] = [];
  if ((needs === "sourcing" || needs === "search") && !serperConfigured()) {
    missing.push("web search — SEARXNG_URL (a SearXNG instance, no key), or SERPER_API_KEY");
  }
  if (!st.configured) missing.push("OPENROUTER_API_KEY (openrouter.ai/keys)");
  else if (needs === "grounded" && !st.webSearch) {
    missing.push("web search — set C141_WEB_SEARCH=on, or use an OpenRouter key");
  }
  const blocked = missing.length > 0;

  // The bar is a client form so it can show the run's progress while it works
  // (GenerateForm); the checks above stay here, on the server.
  const notes = (
    <>
      {blocked && (
        <p className="mt-3 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[12px] leading-relaxed text-warn">
          Not set up on this system yet — an admin needs to add: {missing.join(" · ")}
        </p>
      )}

      {err && (
        <p className="mt-3 rounded-lg bg-danger-soft px-3.5 py-2.5 text-[12px] leading-relaxed text-danger">
          {FAILURE_MESSAGE[err as AiFailure] ?? "That did not work."}
        </p>
      )}

      {found !== undefined && !err && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          {found === "0"
            ? "Nothing came back that could be sourced. Rows with no search result behind them were dropped rather than shown."
            : `${found} sourced ${Number(found) === 1 ? "row" : "rows"} kept`}
          {searches ? ` · ${searches} web ${Number(searches) === 1 ? "search" : "searches"}` : ""}
        </p>
      )}
    </>
  );

  return (
    <GenerateForm openingId={openingId} action={action} blocked={blocked} hasResult={hasResult} needs={needs} notes={notes}>
      <p className="text-[13px] font-medium">{label}</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{sub}</p>
    </GenerateForm>
  );
}

/** Every generated page shows where its claims came from. */
export function Sources({ sources }: { sources: { url: string; title: string; quote: string }[] }) {
  if (sources.length === 0) return null;
  return (
    <section className="mt-6 rounded-xl border border-rule bg-surface px-6 py-5">
      <h2 className="text-[13px] font-semibold">
        Sources <span className="ml-1 font-normal text-ink-faint">{sources.length}</span>
      </h2>
      <ol className="mt-3 flex flex-col gap-3">
        {sources.map((s, i) => (
          <li key={s.url + i} className="text-[12.5px] leading-relaxed">
            <a href={externalUrl(s.url) ?? undefined} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
              {s.title}
            </a>
            {s.quote && <p className="mt-0.5 text-[11.5px] italic text-ink-faint">&ldquo;{s.quote}&rdquo;</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
