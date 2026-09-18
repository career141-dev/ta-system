import { AuraCallButton } from "./AuraCallButton";
import { FollowUpDialog } from "./FollowUpDialog";

/**
 * A candidate in Follow-up, contacted by hand: an Aura call, a WhatsApp
 * follow-up, or a follow-up email.
 *
 * WhatsApp and Email open the conversation first — everything already said to
 * this person on this opening, and what is still missing — and send from
 * there, so nobody sends a "first" message to someone who answered yesterday.
 * WhatsApp and email sent within a few minutes of each other count as one
 * follow-up.
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
      <FollowUpDialog
        applicationId={applicationId}
        openingId={openingId}
        candidateName={candidateName}
        channel="whatsapp"
        label="WhatsApp"
        disabled={!hasPhone}
        title={hasPhone ? "See the conversation and send a WhatsApp follow-up" : "No phone number on file"}
        className={button}
      />
      <FollowUpDialog
        applicationId={applicationId}
        openingId={openingId}
        candidateName={candidateName}
        channel="email"
        label="Email"
        disabled={!hasEmail}
        title={hasEmail ? "See the conversation and send a follow-up email" : "No email address on file"}
        className={button}
      />
    </div>
  );
}
