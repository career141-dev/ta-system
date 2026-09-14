import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const backupPath = path.resolve(
  process.cwd(),
  "../CV-Processing-Recruitment-Pipeline-System/production_backup.zip"
);

if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found at: ${backupPath}`);
  process.exit(1);
}

const stats = fs.statSync(backupPath);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
console.log(`Found production backup: ${backupPath} (${sizeMB} MB)`);
console.log("Restoring into local Convex (http://127.0.0.1:3210)...");

// Read from the environment only. The key used to be a literal fallback here,
// which put a working admin key — one that can read and rewrite the whole
// database — into source control. It lives in .env.local, which is gitignored.
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
if (!adminKey) {
  console.error(
    "CONVEX_SELF_HOSTED_ADMIN_KEY is not set. Put it in .env.local (gitignored) and try again.",
  );
  process.exit(1);
}

// On Windows cmd.exe, the | character in adminKey must be quoted to prevent pipe interpretation
const res = spawnSync(
  "npx",
  [
    "convex",
    "import",
    `"${backupPath}"`,
    "--replace",
    "--yes",
    "--url",
    "http://127.0.0.1:3210",
    "--admin-key",
    `"${adminKey}"`,
  ],
  {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      CONVEX_URL: "http://127.0.0.1:3210",
    },
  }
);

if (res.status === 0) {
  console.log("\nRestoration complete!");
  console.log("Check the local dashboard at: http://localhost:6791");
} else {
  console.error("\nRestoration exited with code:", res.status);
  process.exit(res.status ?? 1);
}
