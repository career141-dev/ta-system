import { revalidatePath } from "next/cache";

import { markTablesStale, resetStore } from "@/data/primeState";
import { convexMutation, convexQuery } from "@/lib/convexServer";
import type { OpeningWriteDeps } from "@/lib/openings/writes";

/** The shared opening writes' dependencies, for the mobile routes. */
export const MOBILE_OPENING_DEPS: OpeningWriteDeps = { revalidatePath, convexQuery, convexMutation, markTablesStale, resetStore };
