import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { PeopleAdmin } from "./PeopleAdmin";
import { allows } from "@/lib/auth";
import { setFollowUpStandard, setAutoShortlistScore } from "@/app/actions";
import { EOD_CC_DEFAULTS, EOD_TO } from "@/lib/eod-format";
import { inputClass } from "@/components/form";
import { primeStore } from "@/data/prime";
import { pendingInvites, offDeskAccounts } from "@/lib/invites";
import { Pager } from "@/components/Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";
import { SubmitButton } from "@/components/SubmitButton";
import { SubmitButton as Submit } from "@/components/Submit";

const PAGE_SIZE = 25;

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q ?? "";
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  // The same test the server makes on every change here.
  const canEdit = allows(user, "user.manage");
  const questions = repo.followUpStandard();
  // The header search, on this page, searches the people on the desk.
  const matching = repo
    .users()
    .filter((u) => matchesQuery(q, u.name, u.email, u.role, u.phone))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive));
  const page = pageFrom(sp, matching.length, PAGE_SIZE);

  return (
    <main className="mx-auto max-w-[1100px] px-8 py-9">
      <h1 className="text-[24px] font-semibold tracking-tight">People</h1>
      <p className="mb-7 mt-1.5 max-w-[70ch] text-[13px] leading-relaxed text-ink-soft">
        Who is on the desk, and what each of them can do.
        {canEdit
          ? " Nobody is deleted — a name on a year of stage changes has to keep resolving, so someone who leaves is marked as left and comes off the pickers."
          : " Only an admin can change this."}
      </p>
      <PeopleAdmin
        users={slicePage(matching, page, PAGE_SIZE)}
        canEdit={canEdit}
        currentUserId={user.id}
        shortlistInbox={repo.shortlistInbox()}
        invites={canEdit ? await pendingInvites() : []}
        otherAccounts={canEdit ? await offDeskAccounts(user.id) : []}
      />
      {q && matching.length === 0 && (
        <p className="mt-4 text-center text-[12.5px] text-ink-faint">Nobody matches that search.</p>
      )}
      <Pager page={page} pageSize={PAGE_SIZE} total={matching.length} href={pageLink("/people", sp)} />

      {/* The bar for pre-shortlisting a new CV. Worth tuning once there is a
          month of scores to look at. */}
      <section className="mt-8 rounded-2xl border border-rule bg-surface px-6 py-5">
        <h2 className="text-[15px] font-semibold">Pre-shortlist score</h2>
        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-soft">
          New CVs and database matches scoring this or more are pre-shortlisted, and wait for the
          TA to confirm. 85 and above is &ldquo;strong&rdquo;, 60 to 84 &ldquo;worth a look&rdquo;.
        </p>
        <form action={setAutoShortlistScore} className="mt-3 flex items-center gap-3">
          <input
            name="score"
            type="number"
            min={40}
            max={100}
            defaultValue={repo.setting("autoShortlistScore", "75")}
            disabled={!canEdit}
            className={`${inputClass} w-[90px]`}
          />
          {canEdit && (
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          )}
        </form>
      </section>

      {/* Who every end-of-day email is copied to. */}
      <section className="mt-8 rounded-2xl border border-rule bg-surface px-6 py-5">
        <h2 className="text-[15px] font-semibold">End-of-day copy</h2>
        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-soft">
          Every end-of-day email starts out to {EOD_TO}, copying {EOD_CC_DEFAULTS.join(", ")}. A TA
          can add or take off To and Cc addresses on the email itself.
        </p>
      </section>

      {/* What follow-up asks every candidate. Each opening can add its own
          questions on top; these are the desk-wide ones. */}
      <section className="mt-8 rounded-2xl border border-rule bg-surface px-6 py-5">
        <h2 className="text-[15px] font-semibold">Standard follow-up questions</h2>
        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-soft">
          Asked on the AI call and chased on WhatsApp for every shortlisted candidate. Switch one
          off and it is no longer asked. A TA adds job-specific questions on the opening itself.
        </p>
        <form action={setFollowUpStandard} className="mt-4 grid gap-2.5">
          {questions.map((q) => (
            <div key={q.id} className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" name={`on_${q.id}`} value="1" defaultChecked={q.enabled} disabled={!canEdit} />
                Ask
              </label>
              <input
                name={`label_${q.id}`}
                defaultValue={q.label}
                disabled={!canEdit}
                className={`${inputClass} max-w-[320px]`}
              />
            </div>
          ))}
          {canEdit && (
            <div>
              <Submit
                tone="dark"
                pendingLabel="Saving…"
                className="rounded-full border border-rule-strong px-5 py-2 text-[13px] font-medium disabled:opacity-60"
              >
                Save questions
              </Submit>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
