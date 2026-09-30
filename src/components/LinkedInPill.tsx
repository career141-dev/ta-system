import { LINKEDIN_STATUS, type LinkedInStatus } from "@/lib/linkedinStatus";

/** A job's LinkedIn connection, as a pill (lib/linkedinStatus). The hint says why on hover. */
export function LinkedInPill({ status }: { status: LinkedInStatus }) {
  const s = LINKEDIN_STATUS[status];
  return (
    <span
      title={s.hint}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-[3px] text-[11px] font-medium ${s.tone}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
