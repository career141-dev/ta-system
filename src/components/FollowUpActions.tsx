import { sendFollowUpNow } from "@/app/actions";
import { AuraCallButton } from "./AuraCallButton";

/**
 * A candidate in Follow-up, contacted by hand: an Aura call, a WhatsApp
 * follow-up, or a follow-up email. Each button does one thing. WhatsApp and
 * email sent within a few minutes of each other count as one follow-up.
 */
export function FollowUpActions({
  applicationId,
  openingId,
  candidateName,
  roleTitle,
  hasPhone,
  hasEmail,
  compact = false,
}: {
  applicationId: string;
  openingId: string;
  candidateName: string;
  roleTitle: string;
  hasPhone: boolean;
  hasEmail: boolean;
  compact?: boolean;
}) {
  const button = compact
    ? "rounded-full border border-rule px-3 py-[5px] text-[12px] font-medium text-ink hover:bg-tag disabled:opacity-35"
    : "rounded-full border border-rule px-4 py-2 text-[12.5px] font-medium text-ink hover:bg-tag disabled:opacity-35";
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "justify-end" : ""}`}>
      <AuraCallButton
        applicationId={applicationId}
        openingId={openingId}
        candidateName={candidateName}
        roleTitle={roleTitle}
        compact={compact}
      />
      <form action={sendFollowUpNow}>
        <input type="hidden" name="appId" value={applicationId} />
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="channel" value="whatsapp" />
        <button className={button} disabled={!hasPhone} title={hasPhone ? "Send a WhatsApp follow-up" : "No phone number on file"}>
          WhatsApp
        </button>
      </form>
      <form action={sendFollowUpNow}>
        <input type="hidden" name="appId" value={applicationId} />
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="channel" value="email" />
        <button className={button} disabled={!hasEmail} title={hasEmail ? "Send a follow-up email" : "No email address on file"}>
          Email
        </button>
      </form>
    </div>
  );
}
