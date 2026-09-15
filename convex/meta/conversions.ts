import { internalAction } from "../_generated/server";
import { v } from "convex/values";

// Helper to hash string via SHA-256 (Meta requirement)
async function hashData(data: string): Promise<string> {
  const normalized = data.trim().toLowerCase();
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const sendConversionEvent = internalAction({
  args: {
    eventName: v.string(), // "Lead", "QualifiedLead", "Schedule", "Hire"
    eventId: v.string(), // Unique ID for deduplication
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const datasetId = process.env.META_DATASET_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    const testEventCode = process.env.META_TEST_EVENT_CODE;

    if (!datasetId || !accessToken) {
      console.warn("[Meta Conversions API] Missing META_DATASET_ID or META_ACCESS_TOKEN in env vars. Skipping.");
      return { success: false, reason: "missing_env_vars" };
    }

    const userData: any = {};
    if (args.email) userData.em = [await hashData(args.email)];
    if (args.phone) {
      // Remove all non-numeric characters for phone hashing (and leading zeros/plus signs)
      const numericPhone = args.phone.replace(/\D/g, "");
      userData.ph = [await hashData(numericPhone)];
    }
    if (args.firstName) userData.fn = [await hashData(args.firstName)];
    if (args.lastName) userData.ln = [await hashData(args.lastName)];
    
    const customData: any = {};
    if (args.jobTitle) {
      customData.job_title = args.jobTitle;
    }

    const payload: any = {
      data: [
        {
          event_name: args.eventName,
          event_time: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
          action_source: "system_generated",
          event_id: args.eventId,
          user_data: userData,
          custom_data: customData
        }
      ]
    };

    if (testEventCode) {
      payload.test_event_code = testEventCode;
    }

    try {
      const response = await fetch(`https://graph.facebook.com/v20.0/${datasetId}/events?access_token=${accessToken}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (!response.ok) {
        console.error("[Meta Conversions API] Error from Meta:", result);
        return { success: false, error: result };
      }

      console.log(`[Meta Conversions API] Successfully sent event ${args.eventName} with ID ${args.eventId}`);
      return { success: true, result };
    } catch (error: any) {
      console.error("[Meta Conversions API] Fetch error:", error.message);
      return { success: false, error: error.message };
    }
  }
});
