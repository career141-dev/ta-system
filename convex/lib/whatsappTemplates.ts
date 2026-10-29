// convex/lib/whatsappTemplates.ts
//
// The two approved Meta templates, by the names they were approved under, and
// the request that sends one. Shared by the follow-up sender
// (communications/metaTemplateSender.ts) and the Settings demo
// (communications/demoSend.ts), so the demo sends exactly what candidates get.
//
// A template is approved per WhatsApp Business account, not per number: a
// number in another account cannot send these until the same names are
// approved there too (29 Oct).

export const TEMPLATE_NAME = {
  initial_outreach: "career141_initial_outreach",
  reengagement: "career141_followup_reminder",
} as const;

export type TemplateType = keyof typeof TEMPLATE_NAME;

/** The parameter count each template was approved with — Meta refuses any other. */
export const TEMPLATE_PARAMS: Record<TemplateType, number> = { initial_outreach: 4, reengagement: 2 };

/** Meta Error 132018: no newlines, tabs or long runs of spaces in a parameter. */
export function templateParam(s: string): string {
  return (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** What a new candidate is asked for — the same four the follow-up starts with. */
export const STANDARD_ASKS = ["CV / Resume", "Current Salary", "Expected Salary", "Notice Period"];

/**
 * The parameters for the Settings demo: a made-up candidate and role, in the
 * order each template was approved with.
 */
export function demoTemplateParams(type: TemplateType, o: { candidateName: string; jobTitle: string }): string[] {
  if (type === "reengagement") return [o.candidateName, o.jobTitle];
  return [
    o.candidateName,
    o.jobTitle,
    `Key requirements for the ${o.jobTitle} role.`,
    STANDARD_ASKS.map((a) => `• ${a}`).join(" | "),
  ];
}

/** The Cloud API `messages` request body for a template. */
export function templatePayload(type: TemplateType, to: string, params: string[], langCode: string) {
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: TEMPLATE_NAME[type],
      language: { code: langCode },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: templateParam(text) })) }],
    },
  };
}
