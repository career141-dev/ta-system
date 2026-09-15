// convex/ta/storage.ts
//
// Whether file storage can be used here, asked without trying to use it.

import { query } from "../_generated/server";

/**
 * True when every setting the R2 client needs is present.
 *
 * The profile used to find out by asking storage/r2:generateDownloadUrl to
 * sign a link and catching the failure — which the backend logs as an uncaught
 * error ("No value provided for input HTTP label: Bucket") on every profile
 * view of a deployment without R2. This reads the same four settings and
 * answers; it reveals nothing about their values.
 */
export const r2Configured = query({
  args: {},
  handler: async () =>
    Boolean(
      process.env.R2_BUCKET_NAME &&
        process.env.R2_ENDPOINT &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY,
    ),
});
