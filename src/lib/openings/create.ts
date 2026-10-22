import { primeStore } from "@/data/prime";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { resetStore, withRealIds } from "@/data/primeState";
import * as backend from "@/data/convex/backend";
import type { User } from "@/data/types";
import { assignableTas } from "@/lib/assignable";
import { convexActorForEmail } from "@/lib/convexServer";
import { CONSENT_TEXT, extractFromText, EMPTY_EXTRACT } from "@/lib/intake";
import { draftJd } from "@/lib/openings/jdDraft";
import type { OpeningWriteDeps } from "@/lib/openings/writes";
import type { WorkLocation } from "@/lib/workLocations";

/**
 * Creating a client and an opening, shared by the web's New opening screen
 * (src/app/actions.ts) and the mobile API, so a job made on the phone is made
 * the same way: the same brief, the same assignment rules, the same bell
 * notifications and the same JD draft straight after (22 Oct). The capability
 * check stays with the caller, as `authorize()` does on the web.
 */

export interface NewOpeningInput {
  clientId: string;
  title: string;
  notes: string;
  /** From /api/recording: `convex:<storageId>`, its length and the consent shown. */
  recordingKey: string | null;
  consentText: string | null;
  durationMs: number | null;
  country: string;
  hiringFor: string;
  targetGender: string | null;
  autoFollowUp: boolean;
  /** Already checked with validateWorkLocations; undefined when the form sent none. */
  workLocations: WorkLocation[] | undefined;
  /** Only a lead's are kept, and only active TAs among them. */
  assignedTaIds: string[];
}

/** `after` from next/server in a request; a test collects the work instead. */
export type NewOpeningDeps = Pick<OpeningWriteDeps, "convexMutation" | "revalidatePath"> & {
  after: (work: () => Promise<void>) => void;
};

/** Screen one's write. Returns the new opening's id, or null when something required is missing. */
export async function saveNewOpening(
  user: User,
  input: NewOpeningInput,
  deps: NewOpeningDeps,
): Promise<string | null> {
  const { clientId, notes, recordingKey, consentText, durationMs, country, hiringFor, autoFollowUp, workLocations } = input;
  const title = input.title.trim();
  if (recordingKey && consentText !== CONSENT_TEXT) {
    throw new Error("Confirm everyone agreed before saving the recording.");
  }
  // Where the job is, whose passport the client wants, and — only where they
  // said so — which gender. These three decide where sourcing looks, so they are
  // asked at intake rather than inferred from the address later (§8A.2).
  const gender = input.targetGender?.trim() || null;

  const isLead = user.role === "ta_lead" || user.role === "admin";
  // A lead assigns from the active TAs only (lib/assignable); anyone else sent
  // is dropped rather than trusted from the form.
  const tas = new Set(assignableTas(repo.users()).map((u) => u.id));
  const assigned = isLead ? input.assignedTaIds.filter((id) => tas.has(id)) : [user.id];

  // No TA is fine: it is assigned later, by workload (plan 4.1).
  if (!clientId || !title) return null;

  const users = repo.users();
  const taLeadId = isLead ? user.id : (users.find((u) => u.role === "ta_lead")?.id ?? user.id);
  const directorId = users.find((u) => u.role === "director")?.id ?? null;

  let openingId: string;

  if (isConvex()) {
    openingId = await backend.createOpening(
      { id: user.id },
      {
        clientId,
        title,
        country,
        workLocations,
        hiringFor,
        targetGender: gender,
        jdMarkdown: "",
        assignedTaIds: assigned,
        taLeadId,
        directorId,
        notesMarkdown: notes,
        recordingKey,
        recordingDurationMs: durationMs,
        consentText,
        briefKind: isLead ? "management_to_lead" : "lead_to_ta",
        briefExtracted: notes.trim() ? { ...extractFromText(notes), title } : undefined,
        autoFollowUp,
      },
    );
    resetStore();
  } else {
    const extracted = notes.trim()
      ? { ...extractFromText(notes), title }
      : { ...EMPTY_EXTRACT, title };

    const briefId = repo.createBrief({
      clientId,
      openingId: null,
      kind: isLead ? "management_to_lead" : "lead_to_ta",
      capturedBy: user.id,
      capturedAt: Date.now(),
      method: recordingKey ? (notes.trim() ? "both" : "recording") : "notes",
      notesMarkdown: notes,
      transcriptStatus: recordingKey ? "unavailable" : "none",
      transcript: null,
      recordingKey,
      recordingDurationMs: durationMs,
      consentAcknowledgedBy: consentText ? user.id : null,
      consentAcknowledgedAt: consentText ? Date.now() : null,
      consentText,
      extracted,
    });

    // The JD stays empty here. It is written on screen two, by the TA.
    openingId = repo.createOpeningFromBrief(briefId, {
      clientId,
      country,
      workLocations,
      hiringFor,
      targetGender: gender,
      jdMarkdown: "",
      taLeadId,
      assignedTaIds: assigned,
      directorId,
      autoFollowUp,
    });
  }

  deps.revalidatePath("/openings", "layout");
  deps.revalidatePath("/alerts");
  deps.revalidatePath("/api/notifications");

  const notifyTaIds = assigned.filter((id) => id !== user.id);
  if (notifyTaIds.length) {
    await Promise.all(
      notifyTaIds.map((taId) =>
        deps
          .convexMutation("ta/notifications:create", {
            userId: taId,
            type: "opening_assigned",
            title: "You were assigned to an opening",
            body: `${user.name} assigned you to ${title}.`,
            jobId: openingId,
          })
          .catch((e) => console.error("[notifications] opening_assigned failed:", e)),
      ),
    );
  }

  // The groundwork starts the moment the job exists, not when somebody finds
  // the button: the JD draft for the TA to read, after the response is sent so
  // creating the opening is not held up.
  //
  // Research and the first round of Suggestions ran here too from 24 Sep, on
  // the first draft. Since 25 Sep the TA works the JD out with the AI in the
  // JD chat, so they wait for the approved JD and start from approveJd,
  // searching with the words the TA agreed.
  deps.after(async () => {
    const step = async (what: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (err) {
        console.error(`[prepare ${openingId}] ${what}`, err);
      }
    };
    if (isConvex()) await step("load", () => primeStore({ openingId }));
    await step("JD draft", () => draftJd(openingId));
    deps.revalidatePath(`/openings/${openingId}`, "layout");
  });

  return openingId;
}

export interface NewClientInput {
  name: string;
  industry: string;
  contactName: string;
  contactTitle: string;
  contactEmail: string;
}

/** A new client. Returns it, or null when it has no name. */
export async function saveNewClient(
  user: User,
  input: NewClientInput,
  deps: Pick<OpeningWriteDeps, "convexMutation" | "revalidatePath" | "markTablesStale">,
): Promise<{ id: string; name: string; industry: string } | null> {
  const name = input.name.trim();
  const industry = input.industry.trim() || "Other";
  if (!name) return null;

  // The form has always asked for the main contact. Until the 12 Sep sweep it
  // was read off the request and thrown away.
  const contactName = input.contactName.trim();
  const contacts = contactName
    ? [
        {
          name: contactName,
          title: input.contactTitle.trim(),
          email: input.contactEmail.trim(),
          isPrimary: true,
        },
      ]
    : [];

  let newId: string;
  if (isConvex()) {
    const actor = await convexActorForEmail(user.email);
    newId = (await deps.convexMutation<string>("ta/clients:add", {
      actorId: actor?._id,
      name,
      industry,
      contacts,
    })) ?? "";
    deps.markTablesStale();
  } else {
    newId = repo.addClient({ name, industry, contacts });
  }

  deps.revalidatePath("/clients");
  deps.revalidatePath("/openings/new");
  return { id: withRealIds(newId), name, industry };
}
