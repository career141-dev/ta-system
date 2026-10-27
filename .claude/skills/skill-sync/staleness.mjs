#!/usr/bin/env node
// Keeps the feature skills in .claude/skills/ honest. Each feature skill ends with a
// `<!-- skill-meta ... -->` block naming the source files it describes and a content hash
// of those files taken when the skill was last checked against the code.
//
//   node .claude/skills/skill-sync/staleness.mjs check            list skills whose sources changed
//   node .claude/skills/skill-sync/staleness.mjs stamp <skill..>  record "checked against the code as it is now"
//   node .claude/skills/skill-sync/staleness.mjs hook             PostToolUse hook (reads JSON on stdin)
//   node .claude/skills/skill-sync/staleness.mjs list <path..>    which skills cover these files
//
// Staleness is a content hash, not a commit count, so uncommitted edits count and a
// stamped skill stops nagging the moment it has been brought up to date.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const git = (args, input, cwd = process.cwd()) =>
  execFileSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const root = (cwd) => git(["rev-parse", "--show-toplevel"], undefined, cwd);

// the block must be the last thing in the file, so an example inside a how-to is never mistaken for one
const META = /<!-- skill-meta\n([\s\S]*?)-->\s*$/;

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    "^" + esc.replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?") + "$",
  );
}

function parseMeta(text) {
  const m = META.exec(text);
  if (!m) return null;
  const meta = { sources: [] };
  let inSources = false;
  for (const line of m[1].split("\n")) {
    if (/^sources:\s*$/.test(line)) { inSources = true; continue; }
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv && !line.startsWith(" ")) { inSources = false; meta[kv[1]] = kv[2].trim(); continue; }
    if (inSources && line.trim()) meta.sources.push(line.trim());
  }
  return meta;
}

function loadSkills(top) {
  const dir = join(top, ".claude", "skills");
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n"); // some editors write CRLF
    const meta = parseMeta(text);
    if (meta?.sources.length) out.push({ name, file, text, meta });
  }
  return out;
}

function expand(top, sources, tracked) {
  const res = sources.map(globToRegExp);
  return tracked.filter((f) => res.some((r) => r.test(f)));
}

function trackedFiles(top) {
  // tracked plus untracked-not-ignored, so a brand new source file counts at once
  const all = git(["ls-files", "--cached", "--others", "--exclude-standard"], undefined, top);
  return all ? all.split("\n").filter((f) => existsSync(join(top, f))) : [];
}

function hashOf(top, files) {
  if (!files.length) return "none";
  const blobs = git(["hash-object", "--stdin-paths"], files.join("\n") + "\n", top).split("\n");
  const h = createHash("sha1");
  files.forEach((f, i) => h.update(f + ":" + blobs[i] + "\n"));
  return h.digest("hex");
}

function check(top) {
  const tracked = trackedFiles(top);
  const rows = [];
  for (const s of loadSkills(top)) {
    const files = expand(top, s.meta.sources, tracked);
    const now = hashOf(top, files);
    const stale = now !== s.meta["verified-hash"];
    let changed = "";
    if (stale && /^[0-9a-f]{7,40}$/.test(s.meta["verified-commit"] || "")) {
      try { changed = git(["diff", "--stat", s.meta["verified-commit"], "--", ...files], undefined, top); } catch { changed = "(verified commit not found locally)"; }
    }
    rows.push({ name: s.name, stale, files: files.length, verified: s.meta["verified-date"] || "never", changed });
  }
  return rows;
}

function stamp(top, names) {
  const tracked = trackedFiles(top);
  const head = git(["rev-parse", "--short", "HEAD"], undefined, top);
  const date = new Date().toISOString().slice(0, 10);
  for (const s of loadSkills(top)) {
    if (!names.includes(s.name) && !names.includes("--all")) continue;
    const files = expand(top, s.meta.sources, tracked);
    const block = `<!-- skill-meta\nverified-commit: ${head}\nverified-hash: ${hashOf(top, files)}\nverified-date: ${date}\nsources:\n${s.meta.sources.map((x) => "  " + x).join("\n")}\n-->`;
    writeFileSync(s.file, s.text.replace(META, () => block + "\n"));
    console.log(`stamped ${s.name} (${files.length} source files, HEAD ${head})`);
  }
}

function coveringSkills(top, paths) {
  const rel = paths.map((p) => relative(top, resolve(top, p)).replace(/\\/g, "/"));
  return loadSkills(top).filter((s) => {
    const res = s.meta.sources.map(globToRegExp);
    return rel.some((p) => res.some((r) => r.test(p)));
  }).map((s) => s.name);
}

function hook() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { return; }
  const file = payload.tool_input?.file_path;
  if (!file || !payload.cwd) return;
  let top;
  try { top = root(payload.cwd); } catch { return; }
  if (!existsSync(join(top, ".claude", "skills", "skill-sync"))) return;
  const names = coveringSkills(top, [file]);
  if (!names.length) return;
  // say it once per skill per session, not on every edit
  const seenFile = join(tmpdir(), `skill-sync-${payload.session_id || "x"}.json`);
  let seen = [];
  try { seen = JSON.parse(readFileSync(seenFile, "utf8")); } catch {}
  const fresh = names.filter((n) => !seen.includes(n));
  if (!fresh.length) return;
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(seenFile, JSON.stringify([...seen, ...fresh]));
  const list = fresh.map((n) => `/${n}`).join(", ");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `Feature skill(s) ${list} describe ${relative(top, resolve(payload.cwd, file)).replace(/\\/g, "/")}. ` +
        `Before you finish this task, bring ${fresh.length > 1 ? "them" : "it"} up to date: edit .claude/skills/<name>/SKILL.md to match the new behaviour, ` +
        `then run: node .claude/skills/skill-sync/staleness.mjs stamp ${fresh.join(" ")}`,
    },
  }));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "hook") hook();
else {
  const top = root(process.cwd());
  if (cmd === "check") {
    const rows = check(top);
    const stale = rows.filter((r) => r.stale);
    for (const r of rows) console.log(`${r.stale ? "STALE" : "ok   "}  /${r.name}  (${r.files} source files, last checked ${r.verified})`);
    for (const r of stale) console.log(`\n--- /${r.name} changed since last check ---\n${r.changed}`);
    console.log(stale.length ? `\n${stale.length} skill(s) need review. Update each SKILL.md, then run: stamp <name>` : "\nAll feature skills match the code.");
    process.exitCode = stale.length ? 1 : 0;
  } else if (cmd === "stamp") stamp(top, args);
  else if (cmd === "list") console.log(coveringSkills(top, args).join("\n") || "(no skill covers these files)");
  else console.log("usage: staleness.mjs check | stamp <skill..|--all> | list <path..> | hook");
}
