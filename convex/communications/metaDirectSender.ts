import { phoneAllowed, suppressed } from "../lib/outboundGuard";

/**
 * metaDirectSender.ts
 *
 * Shared utility for sending free-text WhatsApp messages directly via Meta Cloud API.
 * Replaces all WhatChimp outbound send calls (app.whatchimp.com/api/v1/whatsapp/send).
 *
 * Meta API docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 */

import { resolveRecipient } from "../lib/outreachSafety";

export async function sendMetaFreeText(
  phoneNumberId: string,
  recipientPhone: string,
  message: string,
  accessToken: string
): Promise<{ success: boolean; messageId?: string; error?: string; outsideWindow?: boolean }> {
  // Every free-text WhatsApp — follow-ups, nudges, AI auto-replies — passes here.
  const decision = resolveRecipient("whatsapp", recipientPhone);
  if (!decision.ok) {
    console.warn(`[Meta Direct Sender] ${decision.reason}`);
    return { success: false, error: decision.reason };
  }
  if (decision.note) console.log(`[Meta Direct Sender] Sending WhatsApp${decision.note}`);
  const cleanPhone = decision.to;
  const cleanPhoneId = phoneNumberId.replace(/[^0-9]/g, "");

  if (!cleanPhone || !cleanPhoneId || !accessToken) {
    return {
      success: false,
      error: `Missing required params — phone: ${!!cleanPhone}, phoneId: ${!!cleanPhoneId}, token: ${!!accessToken}`,
    };
  }

  if (!phoneAllowed(cleanPhone)) {
    return { success: false, error: suppressed("WhatsApp message", cleanPhone) };
  }

  const url = `https://graph.facebook.com/v19.0/${cleanPhoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: cleanPhone,
    type: "text",
    text: { body: message },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (response.ok) {
      let data: any = {};
      try {
        data = JSON.parse(responseText);
      } catch {
        return { success: false, error: `Non-JSON response: ${responseText}` };
      }

      const messageId = data.messages?.[0]?.id;
      if (messageId) {
        return { success: true, messageId };
      }
      return { success: false, error: `No message ID in response: ${responseText}` };
    }

    return {
      success: false,
      error: `HTTP ${response.status}: ${responseText}`,
      outsideWindow: isOutsideWindowError(responseText),
    };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Meta saying "that number has not written to you recently enough for free text".
 *
 * Error 131047 — "Message failed to send because more than 24 hours have passed
 * since the customer last replied to this number". 131026 ("message undeliverable")
 * covers the same ground for a recipient we may not message.
 *
 * We guess the window from our own `communications` rows, and that guess is
 * wrong more often than it looks: the same phone number sits on several
 * candidate records, so a reply logged against one leaves another looking
 * silent — or looking active when Meta disagrees. When our guess said "open"
 * and Meta said otherwise, the free text was rejected and the candidate got
 * NOTHING, with a failed row nobody was watching (25 September).
 *
 * Meta is the authority on its own window. Asking it costs one rejected call
 * and is right every time.
 */
export function isOutsideWindowError(responseText: string): boolean {
  if (!responseText) return false;
  try {
    const code = JSON.parse(responseText)?.error?.code;
    if (code === 131047 || code === 131026) return true;
  } catch {
    // Not JSON — fall through to the text match below.
  }
  return /\b(131047|131026)\b/.test(responseText);
}
