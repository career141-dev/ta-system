/** The Extras automobile list: who counts as having worked in automobile (30 Oct). */
import assert from "node:assert/strict";
import test from "node:test";
import { automobileRoleOf } from "../convex/lib/automobileRole";

test("catches current, past and sector evidence at any level", () => {
  assert.equal(automobileRoleOf({ currentJobTitle: "Service Manager", currentEmployer: "Toyota Lanka" })?.level, "manager");
  assert.equal(automobileRoleOf({ currentJobTitle: "Intern", currentEmployer: "Acme Bank", jobHistory: [{ title: "Accountant", company: "United Motors" }] })?.level, "intern");
  assert.match(automobileRoleOf({ currentJobTitle: "HR Executive", sector: "Automotive" })!.matchedBy, /sector/);
  assert.equal(automobileRoleOf({ currentEmployer: "Nissan" })?.title, "(no title)");
});

test("other industries and electric motors are left out", () => {
  assert.equal(automobileRoleOf({ currentJobTitle: "Engineer", currentEmployer: "ABC Electric Motors" }), null);
  assert.equal(automobileRoleOf({ currentJobTitle: "Claims Officer", sector: "Motor Insurance" }), null);
  assert.equal(automobileRoleOf({ currentJobTitle: "Developer", currentEmployer: "Tata Consultancy" }), null);
});
