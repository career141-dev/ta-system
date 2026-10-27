const TRACKING_WEBSITES = new Set(["https://aura.career141.com", "https://ta-system.career141.com"]);

/** Both public aliases serve the same app behind the production proxy. */
export function isTrackingSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    const source = new URL(origin);
    if (!["https:", "http:"].includes(source.protocol) || source.origin !== origin) return false;
    const internal = new URL(req.url);
    // The reverse proxy supplies the external host/protocol, as with invite URLs.
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? internal.host;
    if (!host || /[\s,/@?#\\]/.test(host)) return false;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${host}`).hostname);
    const protocol = req.headers.get("x-forwarded-proto") ?? (local ? internal.protocol.slice(0, -1) : "https");
    if (protocol !== "http" && protocol !== "https") return false;
    const destination = new URL(`${protocol}://${host}`).origin;
    return origin === destination || TRACKING_WEBSITES.has(origin) && TRACKING_WEBSITES.has(destination);
  } catch { return false; }
}
