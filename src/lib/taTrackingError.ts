// Show known setup failures without exposing backend responses or credentials.
export function trackingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/disconnect an existing browser|at least 10|browser limit/i.test(message)) return "Your account has reached its browser limit. Disconnect an old browser before connecting another.";
  if (/account unavailable|account is not connected|user not found/i.test(message)) return "Your TA account could not be found in the tracking service. Ask an admin to check your account.";
  if (/no convex.*configured|no convex admin key|non-local|only.*loopback/i.test(message)) return "Tracking is not configured for this app. Set up its tracking service before starting.";
  if (/could not find.*function|function.*not found|unknown function|not registered/i.test(message)) return "Tracking has not been installed on the server used by this app yet.";
  if (/fetch failed|econnrefused|timed out|network/i.test(message)) return "The tracking service is not responding. Check that it is running, then try again.";
  return "Tracking is not ready on this TA system. Its tracking service needs to be checked.";
}
