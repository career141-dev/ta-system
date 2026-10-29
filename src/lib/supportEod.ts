import type { EffortRow } from "./eod-format";
import type { DailyEmailStatus } from "./dailyEmail";

export interface SupportEodPage {
  emails: {
    id: string; userId: string; date: string; status: DailyEmailStatus;
    workLocationName?: string; revision: number; acceptedAt?: number;
    subject?: string; html?: string; effort?: EffortRow;
  }[];
  nextCursor: string | null;
}
