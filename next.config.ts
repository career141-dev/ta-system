import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The JSON store writes to .data/ at runtime; keep it out of the bundle.
  outputFileTracingIncludes: {},
  output: "standalone",
};

export default nextConfig;
