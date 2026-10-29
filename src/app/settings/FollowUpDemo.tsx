"use client";

import { sendFollowUpDemo } from "@/app/demoSendActions";
import { inputClass } from "@/components/form";
import { ActionNote, SubmitButton, submitted, useInline } from "@/components/Submit";

const BTN = "rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-60";

/** Settings → Follow-up demo: each automatic follow-up message, sent once on a click. */
export function FollowUpDemo() {
  const demo = useInline(sendFollowUpDemo, { refreshOnOk: false });
  return (
    <form onSubmit={(e) => demo.run(submitted(e).formData)} className="space-y-5 rounded-2xl border border-rule bg-surface p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[12px] text-ink-soft">
          Candidate name (sample)
          <input name="candidateName" placeholder="Kamal Perera" className={inputClass} />
        </label>
        <label className="text-[12px] text-ink-soft">
          Job title (sample)
          <input name="jobTitle" placeholder="Accountant" className={inputClass} />
        </label>
      </div>

      <div className="border-t border-rule pt-4">
        <h3 className="text-[13.5px] font-semibold">WhatsApp — from +94 74 219 7476</h3>
        <label className="mt-2 block text-[12px] text-ink-soft">
          Receiver’s WhatsApp number
          <input name="phone" type="tel" placeholder="e.g. 0771234567" className={inputClass} />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <SubmitButton name="send" value="whatsapp:initial" formNoValidate busy={demo.pending} locked={demo.pending} className={BTN}>
            Send initial reach-out template
          </SubmitButton>
          <SubmitButton name="send" value="whatsapp:reminder" formNoValidate busy={demo.pending} locked={demo.pending} className={BTN}>
            Send follow-up reminder template
          </SubmitButton>
        </div>
      </div>

      <div className="border-t border-rule pt-4">
        <h3 className="text-[13.5px] font-semibold">Email — from the configured Career141 mailbox</h3>
        <label className="mt-2 block text-[12px] text-ink-soft">
          Receiver’s email address
          <input name="email" type="email" placeholder="name@example.com" className={inputClass} />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <SubmitButton name="send" value="email:initial" busy={demo.pending} locked={demo.pending} className={BTN}>
            Send initial email
          </SubmitButton>
          <SubmitButton name="send" value="email:reminder" busy={demo.pending} locked={demo.pending} className={BTN}>
            Send follow-up email
          </SubmitButton>
        </div>
      </div>

      <ActionNote result={demo.result} />
    </form>
  );
}
