// convex/mailIntake/setCvs.ts
//
// The people a TA put forward by email who are not on the opening (26
// October). The TAs send their sets — "CLIENT > POSITION > SET 01", CVs
// attached — from Outlook to joborders@ (copied to shortlists@), and many of
// those candidates were never added to the opening: 41 Director replies had
// no set to read against, and 42 names in the TAs' own pipeline tables were
// on no opening at all. Each CV in each set is matched to the opening's
// people by its file name; one that matches nobody is filed onto the opening
// through the mail intake's own reader (process.ts ingestCvs), which reuses a
// profile it already holds. They arrive in New CVs; the Director's replies and
// the TAs' tables move them on. Nothing is sent.

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getGraphToken } from "../lib/graphClient";
import { DIRECTOR_MAILBOXES, matchHouseSubject, parseHouseSubject, type OpeningLite } from "../lib/shortlistMail";
import { isCvFile, nameFromCvFile, someoneNamed } from "../lib/directorReplyAi";
import { isCvAttachment, type MailAttachmentMeta } from "../lib/mailParse";
import { setOpenings } from "../lib/setOpening";
import { ingestCvs } from "./process";

const MAILBOXES = ["joborders@career141.com", "shortlists@career141.com"];

/**
 * Everyone on the opening, by every name we hold for them: many applications
 * carry no name of their own (the first dry run counted 188 CVs "missing",
 * most of them people already there — 26 October), so the profile's is read too.
 */
export const openingPeople = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const out: { applicationId: string; name: string; stage: string }[] = [];
    for (const a of await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", jobId)).collect()) {
      const candidate = await ctx.db.get(a.candidateId);
      // One row per person, both names together: two rows would tie each other and match nobody.
      const name = [...new Set([a.candidateName, candidate?.fullName].filter((n): n is string => Boolean(n?.trim())))].join(" ");
      out.push({ applicationId: a._id as string, name, stage: a.currentStage ?? "new_cvs" });
    }
    return out;
  },
});

export const reconcileSetCvs = internalAction({
  args: {
    dryRun: v.boolean(),
    days: v.optional(v.number()),
    /** Openings the owner says are one position entered twice: sets for \`from\` are filed on \`to\`. */
    sameAs: v.optional(v.array(v.object({ from: v.string(), to: v.string() }))),
  },
  handler: async (ctx, args) => {
    // Like the other catch-ups: nothing started after four minutes; a real run continues itself.
    const deadline = Date.now() + 4 * 60_000;
    const days = Math.min(Math.max(Math.floor(args.days ?? 17), 1), 60);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const token = await getGraphToken();
    if (!token) throw new Error("Microsoft Graph is not configured.");
    const H = { Authorization: `Bearer ${token}` };
    const directors = new Set<string>(DIRECTOR_MAILBOXES);
    type M = { id: string; subject?: string; receivedDateTime?: string; internetMessageId?: string; from?: { emailAddress?: { address?: string } }; box: string };

    // The TAs' set emails, once each: the copy in joborders@ and in shortlists@ is the same message.
    const seen = new Set<string>();
    const sets: M[] = [];
    for (const box of MAILBOXES) {
      let url: string | undefined =
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(box)}/messages` +
        `?$filter=receivedDateTime ge ${since} and hasAttachments eq true` +
        `&$select=id,subject,from,receivedDateTime,internetMessageId&$top=200`;
      for (let page = 0; url && page < 20; page++) {
        const res = await fetch(url, { headers: H });
        if (!res.ok) throw new Error(`${box} could not be listed: Graph ${res.status} ${(await res.text()).slice(0, 200)}`);
        const data = await res.json() as { value?: Omit<M, "box">[]; "@odata.nextLink"?: string };
        for (const m of data.value ?? []) {
          const from = (m.from?.emailAddress?.address ?? "").toLowerCase();
          const subject = m.subject ?? "";
          if (!from.endsWith("@career141.com") || directors.has(from)) continue;
          if (/^\s*(re|fw|fwd)\s*:/i.test(subject) || !parseHouseSubject(subject)) continue;
          const key = m.internetMessageId ?? m.id;
          if (seen.has(key)) continue;
          seen.add(key);
          sets.push({ ...m, box });
        }
        url = data["@odata.nextLink"];
      }
    }
    sets.sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));

    const { openings } = await ctx.runQuery(internal.mailIntake.shortlist.context, {});
    const rows: Record<string, unknown>[] = [];
    let notReached = 0;
    for (const m of sets) {
      if (Date.now() > deadline) { notReached++; continue; }
      const subject = m.subject ?? "";
      const from = (m.from?.emailAddress?.address ?? "").toLowerCase();
      const base = { receivedAt: m.receivedDateTime ?? "", from, subject };
      const house = parseHouseSubject(subject)!;
      const strict = matchHouseSubject(house, openings as OpeningLite[]);
      // The strict reader first; then the desk's own names for the opening (lib/setOpening).
      const fits = strict.opening ? [strict.opening] : setOpenings(house, openings as OpeningLite[]);
      if (!fits.length) { rows.push({ ...base, result: "no_opening", note: strict.note }); continue; }
      try {
        const mailboxPath = `/users/${encodeURIComponent(m.box)}/messages/${encodeURIComponent(m.id)}`;
        const att = await fetch(`https://graph.microsoft.com/v1.0${mailboxPath}/attachments?$select=id,name,contentType,size,isInline`, { headers: H });
        const attachments = att.ok ? (((await att.json()).value ?? []) as MailAttachmentMeta[]) : [];
        const cvs = attachments.filter((a) => isCvAttachment(a) && isCvFile(a.name ?? ""));
        // The same opening entered twice: the copy most of the set is already on.
        const onEach = await Promise.all(fits.map(async (o) => {
          const people = await ctx.runQuery(internal.mailIntake.setCvs.openingPeople, { jobId: o.id as Id<"jobs"> });
          return { o, people, on: cvs.filter((cv) => someoneNamed(cv.name ?? "", people)).length };
        }));
        onEach.sort((a, b) => b.on - a.on);
        if (onEach.length > 1 && onEach[0].on === onEach[1].on) {
          rows.push({ ...base, result: "no_opening", note: `Fits ${fits.length} openings equally (${fits.map((o) => o.title).join(" / ")}) and the set's people are on neither more than the other.` });
          continue;
        }
        const chosen = onEach[0];
        const redirect = args.sameAs?.find((x) => x.from === (chosen.o.id as string));
        const opening = redirect ? (openings as OpeningLite[]).find((o) => o.id === redirect.to) ?? chosen.o : chosen.o;
        const people = opening === chosen.o ? chosen.people : await ctx.runQuery(internal.mailIntake.setCvs.openingPeople, { jobId: opening.id as Id<"jobs"> });
        // Someone on another opening at the same client is not filed here as
        // well: a CV in the wrong set (two Garment Technology people in an
        // Electrical set, 26 October) is reported, not copied across.
        const sameClient = (openings as OpeningLite[]).filter((o) => o.id !== opening.id && o.clientName === opening.clientName);
        const elsewhere = (await Promise.all(sameClient.map((o) => ctx.runQuery(internal.mailIntake.setCvs.openingPeople, { jobId: o.id as Id<"jobs"> })))).flat();
        const jobId = opening.id as Id<"jobs">;
        const job = `${opening.clientName} · ${opening.title}`;
        const onJob: string[] = [];
        const onOther: string[] = [];
        const missing: MailAttachmentMeta[] = [];
        for (const cv of cvs) {
          if (someoneNamed(cv.name ?? "", people)) onJob.push(nameFromCvFile(cv.name ?? ""));
          else if (someoneNamed(cv.name ?? "", elsewhere)) onOther.push(nameFromCvFile(cv.name ?? ""));
          else missing.push(cv);
        }
        const row = { ...base, job, cvs: cvs.length, onJob: onJob.length, onOtherOpening: onOther, missing: missing.map((c) => nameFromCvFile(c.name ?? "")) };
        if (args.dryRun || missing.length === 0) { rows.push({ ...row, result: missing.length ? "would_file" : "all_on_job" }); continue; }
        const placed: string[] = [];
        const ingest = await ingestCvs(
          ctx, token, mailboxPath, missing,
          { jobId, sourceChannel: "email", fromAddress: from, subject, campaign: `TA set — ${m.box}`, shortlistCopy: true },
          // A CV already held: its person is put on the opening, if they are not on it yet.
          async (candidateId) => {
            const apps = await ctx.runQuery(internal.mailIntake.shortlist.applicationsFor, { candidateIds: [candidateId] });
            if (!apps.some((a: { openingId: string }) => a.openingId === (jobId as string))) {
              await ctx.runMutation(internal.applications.applications.createApplication, {
                candidateId, jobId, sourceChannel: "email", metaHeadline: subject.slice(0, 200),
              });
            }
            placed.push(candidateId);
          },
        );
        rows.push({ ...row, result: "filed", reading: ingest.cvUploadIds.length, knownPlaced: placed.length, notes: ingest.notes });
      } catch (e) {
        rows.push({ ...base, result: "error", error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    if (notReached && !args.dryRun) await ctx.scheduler.runAfter(0, internal.mailIntake.setCvs.reconcileSetCvs, args);
    const summary: Record<string, number> = {};
    for (const r of rows) summary[String(r.result)] = (summary[String(r.result)] ?? 0) + 1;
    summary["CVs not on their opening"] = rows.reduce((n, r) => n + ((r.missing as string[] | undefined)?.length ?? 0), 0);
    if (notReached) summary[args.dryRun ? "not reached (time)" : "continued in a new run"] = notReached;
    console.log(`reconcileSetCvs ${args.dryRun ? "dry run" : "run"}: ${JSON.stringify(summary)}`);
    return { dryRun: args.dryRun, days, sets: sets.length, summary, rows };
  },
});
