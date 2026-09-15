import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { PeopleAdmin } from "./PeopleAdmin";
import { allows } from "@/lib/auth";
import { setFollowUpStandard, setAutoShortlistScore } from "@/app/actions";
import { inputClass } from "@/components/form";
import { primeStore } from "@/data/prime";
import { pendingInvites, offDeskAccounts } from "@/lib/invites";

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  await primeStore({ allApplications: true });
  const user = await getCurrentUser();
  // The same test the server makes on every change here.
  const canEdit = allows(user, "user.manage");
  const questions = repo.followUpStandard();

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
        users={repo.users()}
        canEdit={canEdit}
        currentUserId={user.id}
        shortlistInbox={repo.shortlistInbox()}
        invites={canEdit ? await pendingInvites() : []}
        otherAccounts={canEdit ? await offDeskAccounts(user.id) : []}
      />

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
            <button className="rounded-full border border-rule-strong px-5 py-2 text-[13px] font-medium">Save</button>
          )}
        </form>
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
              <button className="rounded-full border border-rule-strong px-5 py-2 text-[13px] font-medium">
                Save questions
              </button>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
