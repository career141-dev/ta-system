import type { Instrumentation } from "next";

/**
 * Every server error as one line a person can search for (28 Sep).
 *
 * Next already prints the stack; what it does not print is the digest the
 * user was shown on the error page (src/app/error.tsx), so a TA's "Reference:
 * 1234" could not be matched to anything. `docker logs ta-prod-app | grep
 * request-error` now lists every failure with its page and reference.
 *
 * The path without its query string: a search's words, a name or a phone
 * number can sit there, and logs are kept.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const digest = typeof err === "object" && err !== null && "digest" in err ? String(err.digest) : "-";
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[request-error] ${request.method} ${request.path.split("?")[0]} ref=${digest} ${context.routeType} ${context.routePath} — ${message.slice(0, 300)}`,
  );
};
