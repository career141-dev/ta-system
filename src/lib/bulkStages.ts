import type { Stage } from "@/data/types";
import { nextStages } from "./pipeline";

// Interviews, offers and placements require their dedicated detail forms.
export const BULK_STAGES: Stage[] = ["ta_follow_up", "director_review", "director_shortlist", "client_shortlist", "rejected", "dropped_out"];

export function bulkStages(stages: Stage[], canDecideDirector: boolean, canDecideClient: boolean): Stage[] {
  const available = new Set(stages.flatMap(nextStages));
  return BULK_STAGES.filter((s) => available.has(s) &&
    (s !== "director_shortlist" || canDecideDirector) &&
    (s !== "client_shortlist" || canDecideClient));
}
