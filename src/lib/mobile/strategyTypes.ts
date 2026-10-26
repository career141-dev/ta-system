/** Native strategy-work contract. Kept identical across backend and TA_APP. */
export interface StrategiesPayload {
  apiVersion: 1;
  context: { openingId: string; title: string; clientName: string };
  counts: { assigned: number; done: number; notApplicable: number };
  access: { canWork: boolean; canManageInPlanner: boolean };
  pendingCount: number;
  rows: StrategyRow[];
}

export interface StrategyRow {
  rowId: string;
  name: string;
  description: string | null;
  struck: boolean;
  doneBy: string[];
  doneByIds: string[];
  mine: boolean;
  acceptance: "not_assigned" | "pending" | "accepted";
  assignedLabel: string;
  doneAtValue: string;
  used: boolean;
  note: string;
  submittedLabel: string | null;
  proofs: { id: string; submitted: boolean; href: string }[];
}

export type StrategyWriteBody =
  | { action: "accept" }
  | { action: "submit"; rows: { rowId: string; used: boolean; date: string; note: string }[] }
  | { action: "remove_proof"; rowId: string; proofId: string };

export interface StrategyWriteResult {
  ok: boolean;
  message: string;
  tone?: "ok" | "note";
}
