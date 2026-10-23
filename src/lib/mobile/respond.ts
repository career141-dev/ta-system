import { NextResponse } from "next/server";

/** The mobile API's replies: JSON, never cached, the same error shape everywhere. */
export const NO_STORE = { "Cache-Control": "private, no-store" };

export function ok<T>(body: T) {
  return NextResponse.json(body, { headers: NO_STORE });
}

export function refuse(status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 | 502, message: string) {
  const error = {
    400: "invalid",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    413: "invalid",
    500: "server",
    501: "server",
    502: "server",
  }[status];
  return NextResponse.json({ error, message }, { status, headers: NO_STORE });
}

export const signedOut = () => refuse(401, "Sign in to continue.");
