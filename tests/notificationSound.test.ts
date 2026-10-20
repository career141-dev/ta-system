/**
 * Tests for notification bell sound, AudioContext interaction unlocking,
 * and strategy assignment notification routing.
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

// Test 1: NotificationBell component has playNotificationBell, AudioContext unlocking and tab title flashing
console.log("\n1. NotificationBell audio acoustics and interaction unlocking");
{
  const bellSrc = read("src/components/NotificationBell.tsx");

  eq("playNotificationBell is exported", bellSrc.includes("export async function playNotificationBell"), true);
  eq("has sharedAudioCtx to prevent suspended timers", bellSrc.includes("let sharedAudioCtx: AudioContext | null = null;"), true);
  eq("has window interaction listeners to unlock AudioContext", bellSrc.includes("window.addEventListener(\"pointerdown\", unlockAudio"), true);
  eq("unlocks on click as well", bellSrc.includes("window.addEventListener(\"click\", unlockAudio"), true);
  eq("resumes suspended AudioContext on trigger", bellSrc.includes("if (ctx.state === \"suspended\")"), true);
  eq("synthesizes dual-tone bell chime", bellSrc.includes("fundamental: 784") && bellSrc.includes("fundamental: 1046.5"), true);
  eq("uses metallic strike transient", bellSrc.includes("strikeFreq: 3136") && bellSrc.includes("strikeFreq: 4186"), true);
  eq("uses dynamics compressor for warm, distortion-free output", bellSrc.includes("createDynamicsCompressor"), true);
  eq("flashes tab title when in background", bellSrc.includes("function flashNotificationTitle"), true);
  eq("provides a test sound button in the popover", bellSrc.includes("Test sound"), true);
  eq("links strategy_assigned directly to /openings/${n.jobId}/strategies", bellSrc.includes("n.type === \"strategy_assigned\" && n.jobId ? `/openings/${n.jobId}/strategies`"), true);
}

// Test 2: Backend Convex notifications route strategy_assigned to strategies tab
console.log("\n2. Backend Convex notifications routing for strategy_assigned");
{
  const convexNotifs = read("convex/ta/notifications.ts");
  eq("convex/ta/notifications includes strategy_assigned", convexNotifs.includes("v.literal(\"strategy_assigned\")"), true);
  eq("convex/ta/notifications resolves href to /strategies", convexNotifs.includes("n.type === \"strategy_assigned\" && n.jobId"), true);
  eq("target is /openings/${n.jobId}/strategies", convexNotifs.includes("`/openings/${n.jobId}/strategies`"), true);
}

// Test 3: actions.ts bellDue debouncing window
console.log("\n3. actions.ts strategy_assigned notification triggers");
{
  const actionsSrc = read("src/app/actions.ts");
  eq("bellDue uses responsive 30s debounce", actionsSrc.includes("ms = 30_000"), true);
  eq("addStrategyDoneBy sends strategy_assigned", actionsSrc.includes("type: \"strategy_assigned\""), true);
  eq("addStrategyDoneBy includes jobId for direct routing", actionsSrc.includes("jobId: openingId"), true);
}

// Test 4: notifications API route is dynamic and un-cached
console.log("\n4. /api/notifications route dynamic headers");
{
  const routeSrc = read("src/app/api/notifications/route.ts");
  eq("route is force-dynamic", routeSrc.includes("export const dynamic = \"force-dynamic\";"), true);
  eq("revalidate is 0", routeSrc.includes("export const revalidate = 0;"), true);
  eq("has no-store cache-control header", routeSrc.includes("Cache-Control\": \"no-store"), true);
}

console.log(`\nTests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
