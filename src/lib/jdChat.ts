import type { JdChatMessage } from "@/data/types";

/** The longest request the JD chat sends — enough for a pasted paragraph. */
export const JD_REQUEST_MAX = 2000;

/**
 * Whether the Job details still follow the notes (25 Sep). Until the TA first
 * asks the AI for a change, every draft reads them from the notes, as before.
 * From then until approval they are left alone; approving the JD reads them
 * from the approved text instead.
 */
export function detailsFollowNotes(chat: Pick<JdChatMessage, "role">[]): boolean {
  return !chat.some((m) => m.role === "user");
}

/** The earlier turns the AI is shown with a new request — what was asked and what it did. */
export function chatHistory(chat: JdChatMessage[]): { role: "user" | "assistant"; body: string }[] {
  return chat.filter((m) => !m.failed).map((m) => ({ role: m.role, body: m.body }));
}
