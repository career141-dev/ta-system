/** The Extras sales list: who counts as sales and at which level (30 Oct). */
import assert from "node:assert/strict";
import test from "node:test";
import { salesRoleOf } from "../convex/lib/salesRole";

const level = (currentJobTitle: string, extra = {}) => salesRoleOf({ currentJobTitle, ...extra })?.level ?? null;

test("levels by title", () => {
  assert.equal(level("Sales Intern"), "intern");
  assert.equal(level("Management Trainee - Sales"), "intern");
  assert.equal(level("Sales Manager Trainee"), "intern"); // intern wins over manager
  assert.equal(level("Area Sales Manager"), "manager");
  assert.equal(level("Head of Sales"), "manager");
  assert.equal(level("Sales Executive"), "executive");
  assert.equal(level("Business Development Officer"), "executive");
  assert.equal(level("Telesales Agent"), "other");
});

test("non-sales titles are left out", () => {
  assert.equal(level("Sales Accountant"), null);
  assert.equal(level("Software Engineer"), null);
  assert.equal(level("Customer Service Executive"), null);
  assert.equal(level("Marketing Executive"), null);
});

test("a bare Executive counts only with sales skills", () => {
  assert.equal(level("Executive"), null);
  assert.equal(level("Executive", { skills: ["B2B Sales", "CRM"] }), "executive");
});

test("falls back to the latest dated job, then older titles", () => {
  const r = salesRoleOf({
    jobHistory: [
      { title: "Clerk", startDate: "2015-01" },
      { title: "Sales Executive", company: "Dialog", startDate: "2021-06" },
    ],
  });
  assert.equal(r?.title, "Sales Executive");
  assert.equal(r?.titleSource, "history");
  assert.equal(salesRoleOf({ pastJobTitles: ["Sales Manager"] })?.titleSource, "older history");
  assert.equal(salesRoleOf({}), null);
});
