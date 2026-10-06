import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A server that runs from .next/standalone, with only the files it traced —
  // what the production image copies (see Dockerfile). `next start` is
  // unaffected, and so is `next dev`.
  output: "standalone",
  // The JSON store writes to .data/ at runtime; keep it out of the bundle.
  // pdf.js on the server needs @napi-rs/canvas for DOMMatrix, and its
  // platform binary is loaded by a runtime require the tracer cannot follow
  // — so the live image had none, and referee reading fell back to pdf2json
  // ("DOMMatrix is not defined", 5 Oct).
  // pdf.js also loads its worker file at runtime (6 Oct: "Cannot find module
  // …/pdf.worker.mjs" on live), so that is traced too.
  outputFileTracingIncludes: {
    "/**/*": ["./node_modules/@napi-rs/**/*", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  // Required as Node packages, not bundled, so they are traced into the
  // standalone server with their native parts.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
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
