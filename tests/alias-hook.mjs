/**
 * Teaches Node the two resolution habits the application's TypeScript relies on
 * and Node does not have: the `@/…` alias, and imports written without a file
 * extension. Next does both when it builds; the test runner has to be told.
 *
 * Nothing here changes what the tests import — they load the same modules the
 * application ships, which is the only way a test is evidence about it.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function firstFile(base) {
  for (const ext of ["", ...EXTS]) {
    const candidate = base + ext;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") {
    return { shortCircuit: true, url: "data:text/javascript,export default {};" };
  }
  if (specifier.startsWith("@/")) {
    const hit = firstFile(path.join(SRC, specifier.slice(2)));
    if (hit) return next(pathToFileURL(hit).href, context);
    throw new Error(`alias hook: cannot resolve ${specifier} under ${SRC}`);
  }

  // Extensionless relative imports, e.g. `./ai` meaning `./ai.ts`.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier)) {
    const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
    if (parent) {
      const hit = firstFile(path.resolve(path.dirname(parent), specifier));
      if (hit) return next(pathToFileURL(hit).href, context);
    }
  }

  return next(specifier, context);
}
