import { isConvex } from "@/data/mode";
import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { FAILURE_MESSAGE } from "@/lib/ai";
import { isDeskWide } from "@/lib/auth";
import { convexActorForEmail } from "@/lib/convexServer";
import { dateAt } from "@/lib/format";
import { benchmarkByDefault, findIncumbents, SENIORITY_LABEL, seniorityOf, type IncumbentRow } from "@/lib/incumbents";
import { contextFor } from "@/lib/openings/jdDraft";
import { decideOn, type OpeningWriteDeps } from "@/lib/openings/writes";
import { DEFAULT_DEPS as WEB, researchViaSearch } from "@/lib/researchSearch";
import { searchProvider, serperConfigured } from "@/lib/serper";
import { MAX_ROUNDS } from "@/lib/sourcing";
import { workdayErrorMessage } from "@/lib/workdayErrors";

export type ResearchWriteOutcome =
  | { ok: true; message: string; tone?: "ok" | "note" }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500 | 502; message: string };

export interface ResearchWriteDeps extends OpeningWriteDeps {
  after: (work: () => Promise<void>) => void;
  rerunSuggestions: (openingId: string, userId: string) => Promise<void>;
}

const SEARCH_NAME: Record<string, string> = { claude: "Claude web search", searxng: "SearXNG", serper: "Serper", openai: "OpenAI web search" };

export function answeredByLabel(by: { search: Record<string, number>; model: Record<string, number> }): string {
  const list = (m: Record<string, number>, name: (key: string) => string) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).map(([key, count]) => `${name(key)} ×${count}`).join(", ");
  const model = (key: string) => (key.startsWith("claude-subscription") ? "Claude" : key);
  return [list(by.search, (key) => SEARCH_NAME[key] ?? key), list(by.model, model)].filter(Boolean).join(" + ");
}

export function reasonInWords(reason: string | undefined): string {
  const sentence = reason && (FAILURE_MESSAGE as Record<string, string>)[reason];
  return sentence ?? (reason ? `${reason}.` : "no reason was given.");
}

export function searchReasonInWords(code: string, detail?: string): string {
  if (code === "no_serper") return "web search is not set up on this system. An admin needs to set SEARXNG_URL (a SearXNG instance) or a search key.";
  if (code === "search_failed") {
    const what = detail ? ` (${detail})` : "";
    return searchProvider() === "searxng"
      ? `the search service could not answer${what}. Nothing is wrong with the client record — an admin needs to look at the search service.`
      : `the search provider refused the request${what}. Check the search key and its credits.`;
  }
  if (code === "rounds_spent") return `all ${MAX_ROUNDS} rounds for this opening are used.`;
  if (code === "no_opening") return "the opening could not be found. Reload the page.";
  if (code === "running") return "it is already running for this opening — it starts by itself when the job is created. The results appear here when it finishes, usually within a few minutes.";
  if (code === "run_spent") return `Research has already been run for this opening${detail ? ` ${detail}` : ""}. It runs once per opening — ask a lead if it has to be run again.`;
  if (code === "benchmark_spent") return `Benchmark has already been run for this opening${detail ? ` on ${detail}` : ""}. It runs once per opening — ask a lead if it has to be run again.`;
  if (code === "nothing_found") return "the search found nothing under the client's name. Check the name on the client record.";
  if (code === "client_not_searchable") return "the client has no searchable name (a code or \"Confidential\"). Put the real name on the client record.";
  return reasonInWords(code);
}

const runningNow = new Set<string>();

async function alone<T>(key: string, busy: T, work: () => Promise<T>): Promise<T> {
  if (runningNow.has(key)) return busy;
  runningNow.add(key);
  try { return await work(); }
  finally { runningNow.delete(key); }
}

type ResearchRun = {
  ok: boolean; reason?: string; detail?: string; filled?: number; sources?: number; competitors?: number;
  modelNote?: string; people?: number; benchmarkNote?: string;
};

export function researchOpening(openingId: string, userId: string, canRerun = false): Promise<ResearchRun> {
  return alone(`research:${openingId}`, { ok: false, reason: "running" }, () => researchOpeningNow(openingId, userId, canRerun));
}

async function researchOpeningNow(openingId: string, userId: string, canRerun = false): Promise<ResearchRun> {
  const context = contextFor(openingId);
  const opening = repo.opening(openingId);
  if (!context || !opening) return { ok: false, reason: "no_opening" };
  const already = repo.research(openingId);
  if (already && !canRerun) {
    const who = repo.users().find((row) => row.id === already.generatedBy)?.name;
    return { ok: false, reason: "run_spent", detail: `${who ? `by ${who} ` : ""}on ${dateAt(already.generatedAt)}` };
  }
  const result = await researchViaSearch({
    clientName: context.clientName, industry: context.industry, where: context.locations.join(", "), title: context.title,
    benchmark: benchmarkByDefault(context.title), clientNotes: repo.client(opening.clientId)?.researchNotes,
  });
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  if (result.benchmarks) saveBenchmarks(openingId, result.benchmarks);
  const prior = repo.research(openingId);
  const fields = { ...result.fields };
  for (const key of prior?.editedFields ?? []) {
    if (key in fields && prior) (fields as unknown as Record<string, unknown>)[key] = (prior.fields as unknown as Record<string, unknown>)[key];
  }
  repo.saveResearch({
    openingId, clientId: opening.clientId, fields, editedFields: prior?.editedFields ?? [], markdown: result.markdown,
    sources: result.sources, searches: result.searches, model: answeredByLabel(result.answeredBy), generatedBy: userId, generatedAt: Date.now(),
  });
  const { competitorProfiles, ...named } = fields;
  const filled = Object.values(named).filter((value) => Array.isArray(value) ? value.length > 0 : String(value ?? "").trim() !== "").length;
  return { ok: true, filled, sources: result.sources.length, competitors: competitorProfiles?.length ?? 0, modelNote: result.modelNote,
    people: result.benchmarks?.length, benchmarkNote: result.benchmarkNote };
}

function saveBenchmarks(openingId: string, rows: IncumbentRow[]) {
  const selected = new Set(repo.benchmarks(openingId).filter((row) => row.isSelected).map((row) => `${(row.name ?? "").toLowerCase()}|${row.company.toLowerCase()}`));
  repo.replaceBenchmarks(openingId, rows.map((row) => ({ ...row, openingId, isSelected: selected.has(`${(row.name ?? "").toLowerCase()}|${row.company.toLowerCase()}`) })));
}

async function maySource(user: User, openingId: string, deps: ResearchWriteDeps) {
  return decideOn(user, "opening.sourcing", { openingId }, deps);
}

export async function runOpeningResearch(user: User, openingId: string, deps: ResearchWriteDeps): Promise<ResearchWriteOutcome> {
  const decision = await maySource(user, openingId, deps);
  if (!decision.ok) return decision;
  const result = await researchOpening(openingId, user.id, isDeskWide(user));
  deps.revalidatePath(`/openings/${openingId}/hh/research`);
  if (!result.ok) return { ok: false, status: 409, message: `Research did not run — ${searchReasonInWords(result.reason ?? "", result.detail)}` };
  const filled = result.filled ?? 0;
  if (filled === 0) return { ok: true, tone: "note", message: "The search ran but nothing could be sourced, so every field is still empty. Try again, or fill in what you know by hand." };
  const rivals = result.competitors ? ` and ${result.competitors} ${result.competitors === 1 ? "competitor" : "competitors"}` : "";
  if (result.modelNote) return { ok: true, tone: "note", message: `The client's website, LinkedIn page${rivals} were found, but the AI could not sort the pages into fields — ${reasonInWords(result.modelNote)} Try again, or fill in the rest by hand.` };
  const opening = repo.opening(openingId);
  const benchmark = result.people === undefined
    ? ` Benchmark was not run: ${opening?.title ?? "this"} is a ${SENIORITY_LABEL[seniorityOf(opening?.title ?? "")]} role — use Find them below if it is needed.`
    : result.benchmarkNote ? ` Benchmark could not name anyone — ${reasonInWords(result.benchmarkNote)}`
      : ` Benchmark: ${result.people} ${result.people === 1 ? "person" : "people"} holding the role, each with a source.`;
  return { ok: true, message: `Research filled in ${filled} of 8 fields${rivals}${result.sources ? ` from ${result.sources} sources` : ""}.${benchmark} Check anything going in front of the client.` };
}

export async function runOpeningBenchmark(user: User, openingId: string, deps: ResearchWriteDeps): Promise<ResearchWriteOutcome> {
  const decision = await maySource(user, openingId, deps);
  if (!decision.ok) return decision;
  const opening = repo.opening(openingId);
  if (!opening) return { ok: false, status: 404, message: "The opening could not be found. Reload the page and try again." };
  if (!serperConfigured()) return { ok: false, status: 409, message: `Benchmark did not run — ${searchReasonInWords("no_serper")}` };
  const already = repo.benchmarks(openingId);
  if (already.length && !isDeskWide(user)) {
    const when = dateAt(Math.max(...already.map((row) => row.generatedAt)));
    return { ok: false, status: 409, message: `Benchmark did not run — ${searchReasonInWords("benchmark_spent", when)}` };
  }
  const client = repo.client(opening.clientId);
  const research = repo.research(openingId)?.fields;
  const run = await findIncumbents({ title: opening.title, where: opening.locations.join(", "), companies: [
    { name: client?.name ?? "the client", website: research?.websiteLink || null, isClient: true },
    ...(research?.competitorProfiles ?? []).map((row) => ({ name: row.name, website: row.website || null, isClient: false })),
  ] }, WEB);
  if (run.modelNote) return { ok: false, status: 502, message: `Benchmark did not run — ${reasonInWords(run.modelNote)}` };
  saveBenchmarks(openingId, run.rows);
  deps.revalidatePath(`/openings/${openingId}/hh/research`);
  const searched = `${run.searches} web ${run.searches === 1 ? "search" : "searches"}`;
  if (run.rows.length === 0) return { ok: true, tone: "note", message: `Nobody could be named (${searched}). A person is shown only when a page or search result says they hold the role${research ? "" : " — run Research first so the competitors are searched too"}.` };
  return { ok: true, message: `Found ${run.rows.length} ${run.rows.length === 1 ? "person" : "people"} holding the role, each with a source · ${searched}.` };
}

export async function toggleOpeningBenchmark(user: User, openingId: string, entryId: string, deps: ResearchWriteDeps): Promise<ResearchWriteOutcome> {
  const decision = await maySource(user, openingId, deps);
  if (!decision.ok) return decision;
  if (!repo.benchmarks(openingId).some((row) => row.id === entryId)) return { ok: false, status: 404, message: "That benchmark person is no longer there. Reload the page." };
  repo.toggleBenchmark(entryId);
  deps.revalidatePath(`/openings/${openingId}/hh`, "layout");
  return { ok: true, message: "Benchmark selection updated." };
}

export async function updateOpeningResearchField(user: User, openingId: string, field: string, value: string, deps: ResearchWriteDeps): Promise<ResearchWriteOutcome> {
  const decision = await maySource(user, openingId, deps);
  if (!decision.ok) return decision;
  const report = repo.research(openingId);
  if (!report || !(field in report.fields)) return { ok: false, status: 404, message: "That research field is no longer available. Reload the page." };
  const current = (report.fields as unknown as Record<string, unknown>)[field];
  repo.updateResearchField(openingId, field, Array.isArray(current) ? value.split(/[;\n]/).map((part) => part.trim()).filter(Boolean) : value);
  deps.revalidatePath(`/openings/${openingId}/hh/research`);
  return { ok: true, message: "Saved." };
}

export async function correctOpeningClient(user: User, openingId: string, researchNotes: string, deps: ResearchWriteDeps): Promise<ResearchWriteOutcome> {
  const decision = await maySource(user, openingId, deps);
  if (!decision.ok) return decision;
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  if (!opening || !client) return { ok: false, status: 404, message: "This job has no client set. Set the client on the job first." };
  const notes = researchNotes.trim().slice(0, 2000);
  if (!notes) return { ok: false, status: 400, message: "Write what you know about the client first — the website, the LinkedIn page or the full company name." };
  if (notes === (client.researchNotes ?? "").trim()) return { ok: false, status: 409, message: "These are the details Research already has. Change or add something, then run again." };
  if (isConvex()) {
    const actor = await convexActorForEmail(user.email);
    await deps.convexMutation("ta/clients:update", { actorId: actor?._id, clientId: client.id, researchNotes: notes });
    deps.markTablesStale();
  } else repo.updateClient(client.id, { researchNotes: notes });
  deps.after(async () => {
    repo.replaceBenchmarks(openingId, []);
    const result = await researchOpening(openingId, user.id, true).catch(() => null);
    if (result?.ok) {
      repo.dismissNewSuggestions(openingId);
      await deps.rerunSuggestions(openingId, user.id).catch(() => undefined);
    }
    deps.revalidatePath(`/openings/${openingId}`, "layout");
  });
  deps.revalidatePath(`/openings/${openingId}`, "layout");
  deps.revalidatePath("/clients");
  return { ok: true, message: `Saved on ${client.name}. Research and Suggestions are running again with these details — it takes a few minutes; reload this page to see them.` };
}

export async function confirmOpeningResearch(
  user: User,
  openingId: string,
  unavailable: Record<string, string>,
  deps: Pick<OpeningWriteDeps, "convexMutation" | "revalidatePath">,
): Promise<ResearchWriteOutcome> {
  try {
    await deps.convexMutation("ta/workdays:saveCheck", { actorId: user.id, jobId: openingId, kind: "research", reason: "", reasons: unavailable, link: "", confirmed: false });
  } catch (error) {
    return { ok: false, status: 409, message: workdayErrorMessage(error, "saveCheck") };
  }
  deps.revalidatePath("/workday");
  deps.revalidatePath(`/openings/${openingId}/hh/suggestions`);
  return { ok: true, message: "Saved." };
}
