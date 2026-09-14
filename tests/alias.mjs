/**
 * Resolves the `@/…` path alias for the test runner.
 *
 * The application is built by Next, which reads the alias out of tsconfig.
 * Node does not, so tests importing `@/lib/scoring` fail to resolve. This hook
 * teaches the runtime the same mapping, and nothing else — tests then import
 * the real modules the application ships, not copies of them.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(new URL("./alias-hook.mjs", import.meta.url), pathToFileURL("./"));
