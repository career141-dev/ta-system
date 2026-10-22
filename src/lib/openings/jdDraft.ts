import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { markTablesStale } from "@/data/primeState";
import { isTa } from "@/lib/auth";
import { convexMutation, convexQuery } from "@/lib/convexServer";
import { generateJdText, type JdBrief, type OpeningContext } from "@/lib/headhunt";
import { buildJd, extractFromText, EMPTY_EXTRACT } from "@/lib/intake";
import { detailsFollowNotes } from "@/lib/jdChat";
import { maxModelCost, modelCost, reserve } from "@/lib/spend";

/**
 * The JD draft and what it is written from, moved out of src/app/actions.ts so
 * the mobile app's New opening starts the same groundwork as the web's (22 Oct).
 * Unchanged otherwise.
 */

/** Everyone's details about an opening, for the JD: the lead's brief and each TA's notes. */
export function jdBriefsFor(openingId: string): JdBrief[] {
  return repo.briefsForOpening(openingId).map((b) => {
    const author = repo.user(b.capturedBy);
    const transcript = b.transcriptStatus === "ready" && b.transcript ? `\n\nFrom the recording:\n${b.transcript}` : "";
    return {
      author: author?.name ?? "someone on the desk",
      role: isTa(author) ? ("ta" as const) : ("lead" as const),
      notes: `${b.notesMarkdown ?? ""}${transcript}`,
    };
  });
}

export function contextFor(openingId: string): OpeningContext | null {
  const o = repo.opening(openingId);
  if (!o) return null;
  const client = repo.client(o.clientId);
  const brief = o.briefId ? repo.brief(o.briefId) : null;
  return {
    title: o.title,
    clientName: client?.name ?? "the client",
    industry: client?.industry ?? "",
    locations: o.locations,
    packageNotes: o.packageNotes,
    mustHaves: brief?.extracted?.mustHaves ?? [],
    nationalities: o.targetNationalities,
    gender: o.targetGender,
  };
}

/** Spec §5.2 — the model writes it, the TA still approves it. */
/**
 * Write the JD draft for an opening, from its brief. The TA reads and approves
 * it; nothing here approves anything. Used by the button, and automatically the
 * moment an opening is created.
 */
export async function draftJd(openingId: string, actorId?: string): Promise<{ ok: boolean; reason?: string } | null> {
  const opening = repo.opening(openingId);
  const c = contextFor(openingId);
  if (!opening || !c) return null;
  const client = repo.client(opening.clientId);

  // The lead's brief and every TA's notes, together. On Convex a brief written
  // by the backend in this same request may not be in the loaded tables yet,
  // so its joined notes stand in when the store has none.
  let briefs = jdBriefsFor(openingId);
  if (isConvex() && !briefs.some((b) => b.notes.trim())) {
    const notes = await convexQuery<string>("ta/openings:briefNotes", { openingId }).catch(() => "");
    const lead = repo.user(opening.taLeadId ?? "");
    if (notes.trim()) briefs = [{ author: lead?.name ?? "the TA lead", role: "lead", notes }];
  }
  const allNotes = briefs.map((b) => b.notes).filter((n) => n.trim()).join("\n\n");
  const extracted = allNotes.trim() ? { ...extractFromText(allNotes), title: opening.title } : { ...EMPTY_EXTRACT, title: opening.title };
  const template = buildJd(extracted, client?.name ?? "the client");
  const context = { ...c, mustHaves: extracted.mustHaves?.length ? extracted.mustHaves : c.mustHaves };

  // Once the TA has started asking the AI for changes, the Job details stay
  // as they were until the JD is approved, and are then read from it (25 Sep).
  const followNotes = detailsFollowNotes(repo.jdChat(openingId));

  if (isConvex()) {
    // The draft is saved in the backend. Nothing is approved here — the TA reads it first.
    // The Job details are read from the same notes at the same time.
    const [res] = await Promise.all([
      generateJdText(context, briefs, template, opening.jdMarkdown ?? ""),
      followNotes ? extractJobDetails(openingId, context, briefs).catch((e) => console.error(`[details ${openingId}]`, e)) : null,
    ]);
    // The backend is the only writer here. It stamps the row's updatedAt, so
    // a second write through the store (repo.updateJd) arrived with an older
    // updatedAt and the commit read it as somebody else's edit — the
    // "Someone else changed this record" every regeneration showed, which also
    // threw away the new draft until the page was reloaded (22 September).
    const writer = actorId ?? opening.assignedTaIds[0] ?? opening.taLeadId ?? null;
    const jd = res.ok ? res.text : template;
    if (!writer) {
      repo.updateJd(openingId, jd);
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    }
    try {
      await convexMutation("ta/openings:saveJd", { actorId: writer, openingId, jdMarkdown: jd });
    } catch (e) {
      console.error(`[draftJd ${openingId}]`, e);
      return { ok: false, reason: "The draft could not be saved. Try again." };
    }
    // The loaded copy is now behind the backend; the next read fetches it.
    const { resetStore } = await import("@/data/prime");
    resetStore();
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  }

  if (followNotes) repo.applyExtractedToOpening(openingId, extracted);
  const res = await generateJdText(context, briefs, template, opening.jdMarkdown ?? "");
  // The template is not a failure state — it is what the desk has always had.
  repo.updateJd(openingId, res.ok ? res.text : template);
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}

/**
 * The Job details — skills, nice-to-haves, seniority, years, location,
 * education, salary, languages, industry — read from the opening and from what
 * the lead and the TA wrote, before any JD is approved.
 *
 * Uses the backend's own JD extractor and normalisation (convex/lib/jdParser —
 * DeepSeek through OpenRouter; convex/lib/jobRequirements — skills split on
 * commas, salary "450k LKR" into numbers, seniority onto the schema's levels),
 * so a value read here is one the panel can show and save back. A field a
 * person corrected is never overwritten. Approving the JD later reads the JD
 * too, filling only what is still blank.
 */
export async function extractJobDetails(openingId: string, c: OpeningContext, briefs: JdBrief[]): Promise<void> {
  const given = briefs.filter((b) => b.notes.trim());
  if (given.length === 0) return;
  const text = [
    `Job title: ${c.title}`,
    `Client: ${c.clientName}${c.industry ? ` (${c.industry})` : ""}`,
    c.locations.length ? `Location: ${c.locations.join(", ")}` : null,
    c.nationalities?.length ? `Hiring: ${c.nationalities.join(", ")} nationals` : null,
    "",
    ...given.map((b) => `${b.role === "lead" ? "TA lead's brief" : "TA's notes"} (${b.author}):\n${b.notes.trim()}\n`),
    given.some((b) => b.role === "ta") && given.some((b) => b.role === "lead")
      ? "Where the TA's notes and the lead's brief disagree, the TA's notes are later and are correct."
      : null,
    // 16 September: without this the package and hybrid working came back as
    // nice-to-have "skills" — "vehicle allowance management".
    "Salary, allowances, benefits and working arrangements are not skills: leave them out of the skill lists.",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const [{ extractSearchRequirements }, { valuesFromExtraction, mapSeniority, SENIORITY_LEVELS }] = await Promise.all([
    import("../../../convex/lib/jdParser"),
    import("../../../convex/lib/jobRequirements"),
  ]);
  const model = "deepseek/deepseek-v4-flash";
  const settle = reserve("job details from notes", maxModelCost(model, text.length + 3000, 1400));
  let result: Awaited<ReturnType<typeof extractSearchRequirements>>;
  try {
    result = await extractSearchRequirements(text, "job_description");
    settle(modelCost(model, result.usage.promptTokens, result.usage.completionTokens));
  } catch (e) {
    settle(0);
    throw e;
  }
  // Every model failed and the parser split words instead: not an extraction.
  if (result.usage.model === "regex-fallback") return;
  const values = valuesFromExtraction(result.requirements);
  // The extractor guesses a level from the duties ("mid", "senior"); a title
  // that names one ("Finance Manager") is the client's own word for it, so the
  // title wins wherever it names a higher level (16 September: a Finance
  // Manager managing four accountants came back Mid-Level, then Senior Executive).
  const byTitle = mapSeniority(c.title);
  const rank = (level: string | undefined) =>
    !level || level === "other" ? -1 : SENIORITY_LEVELS.indexOf(level as (typeof SENIORITY_LEVELS)[number]);
  if (byTitle && byTitle !== "other" && rank(byTitle) > rank(values.seniorityLevel)) {
    values.seniorityLevel = byTitle;
  }
  // A language is asked for once, under Languages — "fluent English" as a
  // skill as well only matches CVs that repeat the phrase.
  const languages = (values.languagesRequired ?? []).map((l) => l.toLowerCase());
  const notLanguage = (skill: string) => !languages.some((l) => skill.toLowerCase().includes(l));
  if (values.requiredSkills) values.requiredSkills = values.requiredSkills.filter(notLanguage);
  if (values.niceToHaveSkills) values.niceToHaveSkills = values.niceToHaveSkills.filter(notLanguage);
  if (values.requiredSkills?.length === 0) delete values.requiredSkills;
  if (values.niceToHaveSkills?.length === 0) delete values.niceToHaveSkills;
  const args = { jobId: openingId, values, model: result.usage.model };
  try {
    await convexMutation("ta/requirements:applyExtraction", { ...args, mode: "replace", keepLocks: true });
  } catch (e) {
    // A backend not yet deployed with `keepLocks` refuses the argument; filling
    // blanks is still right, and a later notes change can be re-extracted.
    if (!/keepLocks|extra field|Validator/i.test((e as Error).message)) throw e;
    await convexMutation("ta/requirements:applyExtraction", { ...args, mode: "fill" });
  }
  markTablesStale();
}
