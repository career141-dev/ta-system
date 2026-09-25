import type { WorkingStage } from "@/data/types";

export const WORKING_STAGES: WorkingStage[] = ["100%", "Follow-up", "Add-on"];

/**
 * Where the working stage of someone not on an opening's team is kept, in the
 * TA settings. The app and the backend both write it, so both read this.
 */
export function workingStageKey(openingId: string, userId: string): string {
  return `workingStage:${openingId}:${userId}`;
}
