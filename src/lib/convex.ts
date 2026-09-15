import { ConvexHttpClient } from "convex/browser";

const convexUrl =
  process.env.NEXT_PUBLIC_CONVEX_URL ||
  process.env.CONVEX_URL ||
  "http://127.0.0.1:3210";

export const convexHttpClient = new ConvexHttpClient(convexUrl);
