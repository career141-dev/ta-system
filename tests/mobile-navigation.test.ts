import assert from "node:assert/strict";
import test from "node:test";

import { mobileDestinations } from "@/lib/mobile/navigation";
import type { Role, User } from "@/data/types";

function user(role: Role): User {
  return {
    id: `u_${role}`,
    name: role,
    email: `${role}@example.test`,
    phone: null,
    routingEmail: null,
    role,
    initials: "TA",
    isActive: true,
  };
}

test("mobile navigation is narrowed by the server-side role policy", () => {
  const admin = mobileDestinations(user("admin")).filter((item) => item.enabled).map((item) => item.key);
  const client = mobileDestinations(user("client")).filter((item) => item.enabled).map((item) => item.key);
  const viewer = mobileDestinations(user("viewer")).filter((item) => item.enabled).map((item) => item.key);

  assert(admin.includes("people"));
  assert(admin.includes("database"));
  assert(!client.includes("database"));
  assert(!client.includes("reports"));
  assert(!client.includes("clients"));
  assert(viewer.includes("clients"));
  assert(viewer.includes("home"));
  assert(viewer.includes("openings"));
});
