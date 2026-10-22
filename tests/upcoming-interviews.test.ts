/**
 * The home's "Upcoming interviews" (src/lib/upcomingInterviews.ts): only
 * interviews on openings the person can open, next five, soonest first.
 * Until 22 Oct the web home listed every interview on the desk.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Role, User } from "@/data/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-upcoming-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { upcomingInterviews } = await import("@/lib/upcomingInterviews");
repo.reset();

const synthetic = (role: Role): User => ({
  id: `u_test_${role}`,
  name: `Test ${role}`,
  email: `${role}@example.test`,
  phone: null,
  routingEmail: null,
  role,
  initials: "TT",
  isActive: true,
});

/** A moment before every interview in the seed, so they all count as ahead. */
const before = Math.min(...repo.interviews().map((i) => i.scheduledAt)) - 1;

test("every interview listed is on an opening the person can open", () => {
  for (const user of [...repo.users().filter((u) => u.isActive), synthetic("client"), synthetic("viewer")]) {
    const mine = new Set(repo.openingsForUser(user).map((o) => o.id));
    for (const iv of upcomingInterviews(user, before)) {
      assert(mine.has(repo.application(iv.applicationId)!.openingId), `${user.role} ${user.name} sees only their openings' interviews`);
    }
  }
});

test("someone on no opening sees none, however many the desk has", () => {
  assert(repo.interviews().some((i) => i.outcome === "pending"), "the seed has pending interviews");
  assert.deepEqual(upcomingInterviews(synthetic("client"), before), []);
});

test("pending only, after now, soonest first, at most five", () => {
  const admin = synthetic("admin");
  const list = upcomingInterviews(admin, before);
  assert(list.length <= 5);
  assert(list.every((i) => i.outcome === "pending" && i.scheduledAt > before));
  for (let n = 1; n < list.length; n++) assert(list[n - 1].scheduledAt <= list[n].scheduledAt);
});
