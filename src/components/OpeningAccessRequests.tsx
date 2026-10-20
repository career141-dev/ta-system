import { decideOpeningAccess, requestOpeningAccess } from "@/app/actions";
import { ProblemState } from "./ProblemState";

export interface AvailableOpening {
  id: string;
  title: string;
  clientName: string;
  positionCode: string | null;
  leadName: string;
  assignedTaNames: string[];
  requestStatus: "pending" | "approved" | "rejected" | null;
  requestedAt: number | null;
}

export interface PendingOpeningAccessRequest {
  id: string;
  openingId: string;
  openingTitle: string;
  clientName: string;
  requesterName: string;
  requestReason: string | null;
  requestedAt: number;
}

function dateTime(at: number): string {
  return new Date(at).toLocaleString("en-GB", {
    timeZone: "Asia/Colombo",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function RequestOpeningAccess({ openings }: { openings: AvailableOpening[] }) {
  const selectable = openings.filter((opening) => opening.requestStatus !== "pending");
  const pending = openings.filter((opening) => opening.requestStatus === "pending");

  return (
    <section className="mb-6 rounded-xl border border-rule bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold">Request access to an opening</h2>
        <p className="text-[12.5px] text-ink-soft">
          Select an active opening. It will appear in My Openings only after its TA Lead approves you.
        </p>
      </div>

      {selectable.length > 0 ? (
        <form action={requestOpeningAccess} className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="grid gap-1.5 text-[12px] font-medium text-ink-soft">
            Available opening
            <select
              name="openingId"
              required
              defaultValue=""
              className="h-10 min-w-0 rounded-lg border border-rule bg-white px-3 text-[13px] text-ink outline-none focus:border-brand"
            >
              <option value="" disabled>Select client and position</option>
              {selectable.map((opening) => (
                <option key={opening.id} value={opening.id}>
                  {opening.clientName} — {opening.title}{opening.positionCode ? ` (${opening.positionCode})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-[12px] font-medium text-ink-soft">
            Reason <span className="font-normal text-ink-faint">(optional)</span>
            <input
              name="reason"
              maxLength={1000}
              placeholder="Why do you need access?"
              className="h-10 min-w-0 rounded-lg border border-rule bg-white px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
            />
          </label>
          <button className="h-10 rounded-lg bg-brand px-4 text-[12.5px] font-semibold text-white hover:opacity-90">
            Request access
          </button>
        </form>
      ) : (
        <p className="mt-4 text-[12.5px] text-ink-faint">No other active openings are available.</p>
      )}

      {pending.length > 0 && (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Waiting for approval</p>
          <ul className="mt-2 grid gap-1.5 text-[12.5px] text-ink-soft">
            {pending.map((opening) => (
              <li key={opening.id}>
                {opening.clientName} — {opening.title} · {opening.leadName}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The direct-link state for an opening a TA can discover but cannot read yet. */
export function OpeningAccessNeeded({ opening }: { opening: AvailableOpening }) {
  if (opening.requestStatus === "pending") {
    return (
      <ProblemState
        title="Access request waiting for approval"
        message={`Your request for ${opening.clientName} — ${opening.title} is waiting for ${opening.leadName}. You can open it after approval.`}
        primaryHref="/openings"
        primaryLabel="Go to Openings"
      />
    );
  }

  return (
    <ProblemState
      title="You don’t have access to this opening yet"
      message={`Request access to ${opening.clientName} — ${opening.title}. The responsible TA Lead must approve you before you can see its candidates or work on it.`}
      primaryHref="/openings"
      primaryLabel="Go to Openings"
    >
      <form action={requestOpeningAccess} className="mt-5 grid max-w-xl gap-3">
        <input type="hidden" name="openingId" value={opening.id} />
        <label className="grid gap-1.5 text-[12px] font-medium text-ink-soft">
          Reason <span className="font-normal text-ink-faint">(optional)</span>
          <textarea
            name="reason"
            maxLength={1000}
            rows={2}
            placeholder="Why do you need access?"
            className="resize-y rounded-lg border border-rule bg-white px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
          />
        </label>
        <button className="w-fit rounded-lg bg-brand px-4 py-2 text-[12.5px] font-semibold text-white hover:opacity-90">
          Request access
        </button>
      </form>
    </ProblemState>
  );
}

export function OpeningAccessApprovalQueue({ requests }: { requests: PendingOpeningAccessRequest[] }) {
  if (requests.length === 0) return null;

  return (
    <section id="access-requests" className="mb-6 rounded-xl border border-brand/25 bg-surface p-5">
      <div>
        <h2 className="text-[14px] font-semibold">Opening access requests</h2>
        <p className="mt-1 text-[12.5px] text-ink-soft">Approve a TA to add them as a supporting recruiter.</p>
      </div>
      <div className="mt-4 grid gap-3">
        {requests.map((request) => (
          <form key={request.id} action={decideOpeningAccess} className="rounded-lg border border-rule bg-paper/40 p-4">
            <input type="hidden" name="requestId" value={request.id} />
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold">{request.requesterName}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-soft">{request.clientName} — {request.openingTitle}</p>
                <p className="mt-1 text-[11.5px] text-ink-faint">Requested {dateTime(request.requestedAt)}</p>
              </div>
              {request.requestReason && (
                <p className="max-w-xl rounded-md bg-white px-3 py-2 text-[12px] text-ink-soft">{request.requestReason}</p>
              )}
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="grid flex-1 gap-1 text-[11.5px] font-medium text-ink-soft">
                Decision note <span className="font-normal text-ink-faint">(required when rejecting)</span>
                <textarea
                  name="reason"
                  maxLength={1000}
                  rows={2}
                  placeholder="Add a rejection reason or optional approval note"
                  className="min-h-16 resize-y rounded-lg border border-rule bg-white px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
                />
              </label>
              <div className="flex gap-2">
                <button type="submit" name="decision" value="reject" className="h-9 rounded-lg border border-rule px-3 text-[12px] font-semibold text-ink-soft hover:bg-white">
                  Reject
                </button>
                <button type="submit" name="decision" value="approve" className="h-9 rounded-lg bg-brand px-3 text-[12px] font-semibold text-white hover:opacity-90">
                  Approve
                </button>
              </div>
            </div>
          </form>
        ))}
      </div>
    </section>
  );
}
