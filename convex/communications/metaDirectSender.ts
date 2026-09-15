/**
 * metaDirectSender.ts
 *
 * Shared utility for sending free-text WhatsApp messages directly via Meta Cloud API.
 * Replaces all WhatChimp outbound send calls (app.whatchimp.com/api/v1/whatsapp/send).
 *
 * Meta API docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 */

export async function sendMetaFreeText(
  phoneNumberId: string,
  recipientPhone: string,
  message: string,
  accessToken: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const cleanPhone = recipientPhone.replace(/[^0-9]/g, "");
  const cleanPhoneId = phoneNumberId.replace(/[^0-9]/g, "");

  if (!cleanPhone || !cleanPhoneId || !accessToken) {
    return {
      success: false,
      error: `Missing required params — phone: ${!!cleanPhone}, phoneId: ${!!cleanPhoneId}, token: ${!!accessToken}`,
    };
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

    return { success: false, error: `HTTP ${response.status}: ${responseText}` };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}
