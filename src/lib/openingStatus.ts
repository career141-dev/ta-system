import type { Opening } from "@/data/types";

export type OpeningStatus = Opening["status"];
export type OpeningBucket = "mine" | "all" | "unassigned" | "hold" | "placed" | "closed";

export const OPENING_STATUS_LABEL: Record<OpeningStatus, string> = {
  open: "Active",
  on_hold: "On hold",
  filled: "Placed",
  closed: "Closed / Lost",
};

export const OPENING_BUCKETS: { key: OpeningBucket; label: string }[] = [
  { key: "mine", label: "My openings" },
  { key: "all", label: "All active" },
  // Openings entered before anyone is free to take them (plan 4.1, 21 Sep).
  { key: "unassigned", label: "Unassigned" },
  { key: "hold", label: "On hold" },
  { key: "placed", label: "Placed" },
  { key: "closed", label: "Closed / Lost" },
];

/**
 * The stored values stay unchanged, but successful and unsuccessful outcomes
 * must never share a bucket: "filled" means we placed someone, while "closed"
 * means the requirement ended without a placement (client feedback, 16 Oct).
 */
export function statusMatchesBucket(status: OpeningStatus, bucket: OpeningBucket): boolean {
  if (bucket === "hold") return status === "on_hold";
  if (bucket === "placed") return status === "filled";
  if (bucket === "closed") return status === "closed";
  return status === "open";
}
