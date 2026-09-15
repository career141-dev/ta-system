import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The JSON store writes to .data/ at runtime; keep it out of the bundle.
  outputFileTracingIncludes: {},
  // This project's own folder is the root. With a second lockfile in a parent
  // folder Next otherwise guesses the parent, and traces files from there.
  outputFileTracingRoot: path.resolve(__dirname),
  webpack(config, { isServer }) {
    /*
     * Module concatenation off for the browser bundle.
     *
     * With it on, webpack merged the report builder ("use client") into the
     * module of the spec it imports, so the builder had no module id of its own
     * and was missing from the client reference manifest. /reports then failed
     * with a 500 in every production build — "Could not find the module
     * ReportBuilder.tsx#ReportBuilder in the React Client Manifest". Measured
     * cost of turning it off: 3.8 KB across all client chunks (0.3%).
     */
    if (!isServer) config.optimization.concatenateModules = false;
    return config;
  },
};

export default nextConfig;
