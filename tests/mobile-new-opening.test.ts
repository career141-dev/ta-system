/**
 * New opening (src/lib/openings/create.ts), shared by the web's form and the
 * mobile API: the same assignment rules, the same brief, the same bell and the
 * same JD draft afterwards. Run against a disposable copy of the seed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-mobile-new-opening-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");
const { saveNewOpening, saveNewClient } = await import("@/lib/openings/create");
const { mobileNewOpening } = await import("@/lib/mobile/newOpening");
const { newOpeningBody, newClientBody, parseBody } = await import("@/lib/mobile/openingsBodies");
const { CONSENT_TEXT } = await import("@/lib/intake");
repo.reset();

function fakeDeps() {
  const revalidated: string[] = [];
  const notified: Record<string, unknown>[] = [];
  const later: (() => Promise<void>)[] = [];
  return {
    revalidated,
    notified,
    later,
    deps: {
      revalidatePath: (p: string) => void revalidated.push(p),
      convexQuery: async <T,>() => undefined as T,
      convexMutation: async <T,>(name: string, args: Record<string, unknown>) => (notified.push({ name, ...args }), undefined as T),
      markTablesStale: () => undefined,
      resetStore: () => undefined,
      after: (work: () => Promise<void>) => void later.push(work),
    },
  };
}

const user = (role: string) => repo.users().find((u) => u.role === role && u.isActive)!;
const input = (over: Record<string, unknown> = {}) => ({
  clientId: repo.clients()[0].id,
  title: "  Plant Manager ",
  notes: "",
  recordingKey: null,
  consentText: null,
  durationMs: null,
  country: "Sri Lanka",
  hiringFor: "local",
  targetGender: null,
  autoFollowUp: false,
  workLocations: undefined,
  assignedTaIds: [],
  ...over,
});

test("a client and a position are required, as on the web", async () => {
  const { deps } = fakeDeps();
  assert.equal(await saveNewOpening(user("ta"), input({ clientId: "" }), deps), null);
  assert.equal(await saveNewOpening(user("ta"), input({ title: "   " }), deps), null);
});

test("a TA's opening is theirs; nobody is notified, and the JD draft is queued", async () => {
  const { deps, notified, later, revalidated } = fakeDeps();
  const ta = user("ta");
  const before = repo.openings().length;
  const id = await saveNewOpening(ta, input({ assignedTaIds: ["someone_else"] }), deps);
  assert(id);
  assert.equal(repo.openings().length, before + 1);
  const o = repo.opening(id)!;
  assert.equal(o.title, "Plant Manager");
  assert.deepEqual(o.assignedTaIds, [ta.id]);
  assert.deepEqual(notified, []);
  assert.equal(later.length, 1);
  assert(revalidated.includes("/openings"));
});

test("a lead assigns only active TAs, and each one is told", async () => {
  const { deps, notified } = fakeDeps();
  const lead = user("ta_lead");
  const ta = user("ta");
  const inactive = repo.users().find((u) => !u.isActive);
  const id = await saveNewOpening(lead, input({ assignedTaIds: [ta.id, inactive?.id ?? "ghost", "ghost"] }), deps);
  const o = repo.opening(id!)!;
  assert.deepEqual(o.assignedTaIds, [ta.id]);
  assert.equal(o.taLeadId, lead.id);
  assert.deepEqual(notified.map((n) => [n.name, n.userId, n.body]), [["ta/notifications:create", ta.id, `${lead.name} assigned you to Plant Manager.`]]);
});

test("a recording is kept on the brief with the consent agreed to", async () => {
  const { deps } = fakeDeps();
  const id = await saveNewOpening(user("ta"), input({ notes: "CIMA, 10 years", recordingKey: "convex:abc", consentText: CONSENT_TEXT, durationMs: 61000 }), deps);
  const brief = repo.brief(repo.opening(id!)!.briefId!)!;
  assert.equal(brief.method, "both");
  assert.equal(brief.recordingKey, "convex:abc");
  assert.equal(brief.consentText, CONSENT_TEXT);
  assert.equal(brief.recordingDurationMs, 61000);
});

test("a client needs a name; industry falls back to Other; the contact is kept", async () => {
  const { deps } = fakeDeps();
  const blank = { name: " ", industry: "", contactName: "", contactTitle: "", contactEmail: "" };
  assert.equal(await saveNewClient(user("ta_lead"), blank, deps), null);
  const made = await saveNewClient(user("ta_lead"), { ...blank, name: " Delmo Holdings ", contactName: "Ayesha", contactEmail: "a@example.test" }, deps);
  assert.equal(made?.name, "Delmo Holdings");
  assert.equal(made?.industry, "Other");
  const c = repo.client(made!.id)!;
  assert.equal(c.contacts[0]?.name, "Ayesha");
});

test("the form's lists: TAs only for a lead, and the web's countries", () => {
  const forLead = mobileNewOpening(user("ta_lead"));
  assert.equal(forLead.isLead, true);
  assert(forLead.tas.length > 0);
  assert.equal(forLead.localNationality["Sri Lanka"], "Sri Lankan");
  assert(forLead.countries.includes("Qatar"));
  assert.equal(forLead.consentText, CONSENT_TEXT);
  const forTa = mobileNewOpening(user("ta"));
  assert.equal(forTa.isLead, false);
  assert.deepEqual(forTa.tas, []);
});

test("bodies: a recording key must be one /api/recording gave", () => {
  const body = {
    clientId: "c1", title: "T", country: "Sri Lanka", hiringFor: "local", targetGender: "", workLocations: [{ id: "location_1", name: "Colombo", vacancies: 1 }],
    notes: "", recording: { key: "convex:abc", durationMs: 1000, consentText: "x" }, autoFollowUp: false, assignedTaIds: [],
  };
  assert.equal(parseBody(newOpeningBody, body, "no").ok, true);
  assert.equal(parseBody(newOpeningBody, { ...body, recording: { ...body.recording, key: "../../etc" } }, "no").ok, false);
  assert.equal(parseBody(newOpeningBody, { ...body, targetGender: "Other" }, "no").ok, false);
  assert.equal(parseBody(newClientBody, { name: "A", industry: "", contactName: "", contactTitle: "", contactEmail: "", extra: 1 }, "no").ok, false);
});
