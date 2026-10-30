// convex/lib/senderRouting.ts
//
// Which WhatsApp number a message to a candidate goes from, and whether a TA's
// number is ready to send — the rules, and nothing that reads the database or
// calls Meta, so they can be tested on their own (tests/senderrouting.test.ts).
//
// Each TA's own number sends their candidates' follow-ups while staying on the
// TA's phone (WhatsApp Business app coexistence, the owner, 30 Oct). A TA
// number is only used once it is `ready`; until then, and whenever it fails,
// the main Career141 line sends, so a candidate is never left unmessaged.

import { TEMPLATE_NAME } from "./whatsappTemplates";

export interface SenderNumber {
  phone: string;
  /** Meta phone_number_id (the `whatchimpPhoneId` column). */
  phoneId: string;
  userId?: string;
  /** false: added but not checked with Meta. Missing: a row from before 30 Oct, used as it always was. */
  ready?: boolean;
}

const last9 = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").slice(-9);

/**
 * The phone_number_id to send from, or null for the main line. In order:
 *  1. the number typed on the opening (`outreachWhatsAppNumber`), unless known not ready
 *  2. the candidate's owner TA's number, then the opening's first assigned TA's — only when ready
 *  3. the opening's inbound WhatsApp channel number, unless known not ready
 * A TA's number is checked before the channel number because the channel is
 * usually the main line, which would otherwise always win.
 */
export function pickSender(o: {
  override?: string | null;
  ownerTaId?: string | null;
  assignedTaIds?: string[] | null;
  channelNumber?: string | null;
  numbers: SenderNumber[];
}): SenderNumber | null {
  const byPhone = (p?: string | null) =>
    last9(p) ? o.numbers.find((n) => last9(n.phone) === last9(p) && n.ready !== false) ?? null : null;
  const byTa = (id?: string | null) => (id ? o.numbers.find((n) => n.userId === id && n.ready === true) ?? null : null);
  return byPhone(o.override) ?? byTa(o.ownerTaId) ?? byTa(o.assignedTaIds?.[0]) ?? byPhone(o.channelNumber);
}

/**
 * Meta errors that mean the sending number or its WhatsApp account cannot send
 * at all, rather than something about this candidate: payment not settled
 * (131042), account locked (131031), template missing in that account (132001),
 * number not registered (133010), token without access (10, 190, 200).
 */
export const isNumberLevelError = (metaError: string) =>
  /"code":\s*(10|190|200|131031|131042|132001|133010)\b/.test(metaError);

/** What Meta says about one number, as `checkWithMeta` reads it. Any part may be an error message. */
export interface MetaNumberState {
  phone: { status?: string; platform_type?: string; display_phone_number?: string } | string;
  templates: { name: string; status: string }[] | string;
  subscribedApps: unknown[] | string;
}

/** Ready only when the number is on the Cloud API, both templates are approved, and replies reach us. */
export function numberReadiness(rowPhone: string, m: MetaNumberState): { ready: boolean; note: string } {
  const problems: string[] = [];
  if (typeof m.phone === "string") problems.push(`the API user cannot reach this number (${m.phone})`);
  else {
    if (m.phone.display_phone_number && last9(m.phone.display_phone_number) !== last9(rowPhone))
      problems.push(`Meta has ${m.phone.display_phone_number} under this ID, not ${rowPhone}`);
    if (m.phone.platform_type !== "CLOUD_API") problems.push("not connected to the Cloud API yet");
    if (m.phone.status && m.phone.status !== "CONNECTED") problems.push(`status is ${m.phone.status}`);
  }
  if (typeof m.templates === "string") problems.push(`templates could not be read (${m.templates})`);
  else
    for (const name of Object.values(TEMPLATE_NAME)) {
      const t = m.templates.find((x) => x.name === name);
      if (t?.status !== "APPROVED") problems.push(`${name} is ${t ? t.status.toLowerCase() : "missing"}`);
    }
  if (typeof m.subscribedApps === "string") problems.push(`webhooks could not be read (${m.subscribedApps})`);
  else if (m.subscribedApps.length === 0) problems.push("replies are not sent to us (no app subscribed)");
  return problems.length
    ? { ready: false, note: `Not ready: ${problems.join("; ")}.` }
    : { ready: true, note: "Ready: connected, both templates approved, replies reach us." };
}
