/**
 * Screen work on a laptop with invented data and no real sign-in service.
 *
 * `C141_UI_ONLY=on` (set by deploy/local/start-ui.sh) takes Clerk out of the
 * request: no middleware handshake, no Clerk provider, and signing out clears
 * the development sign-in cookie instead. Ignored in a production build, like
 * the development sign-in it depends on.
 *
 * The browser half reads NEXT_PUBLIC_C141_UI_ONLY, which the same script sets.
 */
export function uiOnly(): boolean {
  return (
    (process.env.C141_UI_ONLY === "on" || process.env.NEXT_PUBLIC_C141_UI_ONLY === "on") &&
    process.env.C141_DEV_SIGNIN === "on" &&
    process.env.NODE_ENV !== "production"
  );
}
