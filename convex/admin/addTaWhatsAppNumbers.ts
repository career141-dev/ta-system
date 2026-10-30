/**
 * Add each TA's own WhatsApp number to `whatsappNumbers`, tied to the TA (30 Oct).
 *
 * New rows start `ready: false`: nothing sends from them until Settings →
 * WhatsApp numbers → "Check with Meta" passes (lib/senderRouting). A number
 * already in the table only gains its TA and WhatsApp account ID; its
 * readiness is left alone, so a line that sends today keeps sending.
 *
 * The TA is found by the user's own phone, else by first name among active
 * users, and must be exactly one person — the dry run lists who matched.
 * Run only through the release pipeline, first dryRun=true and then dryRun=false.
 *
 *   run_function: admin/addTaWhatsAppNumbers:run
 *   run_args:     {"dryRun":true}
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// From WhatsApp Manager, 29–30 Oct. Sanduni's phone_number_id is not known
// yet; her row is skipped until it is filled in here.
const NUMBERS: { firstName: string | null; label: string; phone: string; wabaId: string; phoneId: string | null }[] = [
  { firstName: null, label: "TA lead", phone: "+94742932084", wabaId: "2715214465539258", phoneId: "1287046157815437" },
  { firstName: "Sanduni", label: "Sanduni", phone: "+94764263120", wabaId: "1811583086509201", phoneId: null },
  { firstName: "Priya", label: "Priya", phone: "+919821761894", wabaId: "1870438294389613", phoneId: "1377752375423047" },
  { firstName: "Thushini", label: "Thushini", phone: "+94779077728", wabaId: "2352137355594113", phoneId: "1147756625098092" },
  { firstName: "Hassan", label: "Hassan", phone: "+94740110140", wabaId: "1005624849012436", phoneId: "1276466655555760" },
  { firstName: "Uzmaan", label: "Uzmaan", phone: "+94753778899", wabaId: "150536594816720", phoneId: "151216248081257" },
];

const last9 = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").slice(-9);

export const run = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, args) => {
    const users = (await ctx.db.query("users").collect()).filter((u) => u.isActive);
    const rows = await ctx.db.query("whatsappNumbers").collect();
    const report: string[] = [];

    for (const n of NUMBERS) {
      if (!n.phoneId) {
        report.push(`${n.label} ${n.phone}: skipped — phone_number_id not known yet.`);
        continue;
      }
      const byPhone = users.filter((u) => last9(u.phone) === last9(n.phone));
      const byName = n.firstName
        ? users.filter((u) => (u.fullName ?? "").trim().toLowerCase().split(/\s+/)[0] === n.firstName!.toLowerCase())
        : [];
      const matches: Doc<"users">[] = byPhone.length === 1 ? byPhone : byName;
      const user = matches.length === 1 ? matches[0] : null;
      const who = user
        ? `${user.fullName} <${user.email}>`
        : `NO TA (${matches.length} matches${matches.length ? ": " + matches.map((u) => u.fullName).join(", ") : ""})`;

      const existing = rows.find((r) => last9(r.phone) === last9(n.phone));
      if (existing) {
        report.push(`${n.label} ${n.phone}: already listed — set TA ${who}, WhatsApp account ${n.wabaId}.`);
        if (existing.whatchimpPhoneId !== n.phoneId)
          report.push(`  note: its phone_number_id is ${existing.whatchimpPhoneId}, Meta's list says ${n.phoneId}; left as it is.`);
        if (!args.dryRun) await ctx.db.patch(existing._id, { wabaId: n.wabaId, ...(user ? { userId: user._id } : {}) });
        continue;
      }
      report.push(`${n.label} ${n.phone}: add (not ready) — TA ${who}, phone_number_id ${n.phoneId}.`);
      if (!args.dryRun)
        await ctx.db.insert("whatsappNumbers", {
          name: user?.fullName ?? n.label,
          phone: n.phone,
          whatchimpPhoneId: n.phoneId,
          wabaId: n.wabaId,
          createdAt: new Date().toISOString(),
          ...(user ? { userId: user._id } : {}),
          ready: false,
          readyNote: "Not ready: not checked with Meta yet.",
        });
    }
    return { dryRun: args.dryRun, report };
  },
});
