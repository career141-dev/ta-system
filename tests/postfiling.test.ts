/**
 * Post routing on the shared mailboxes (convex/pipeline/postFiling.ts, 22 Sep):
 * every opening's first post, and the rules as the live poller uses them.
 * Pure — no Graph, no database.
 */
import { firstPostFor } from "../convex/lib/firstPost";
import { linkedinProjectId, routeShared, type RoutablePost } from "../convex/lib/postRouting";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const job = (extra: Record<string, unknown> = {}) =>
  ({ _id: "op_1", title: "Head of Finance", keyword: "HOF-7K", location: "Colombo, Sri Lanka", primaryRecruiterId: "u_shamra", status: "active", ...extra }) as never;

console.log("\nan opening's first post");
{
  const p = firstPostFor(job(), 1);
  eq("carries the opening's title", p.title, "Head of Finance");
  eq("keeps the old keyword as an alias", p.aliasKeywords, ["HOF-7K"]);
  eq("belongs to the primary recruiter", p.assignedTaId, "u_shamra");
  eq("city and country from the location", [p.city, p.country], ["Colombo", "Sri Lanka"]);
  eq("live on an active opening", p.status, "live");
  eq("a LinkedIn advert", p.channel, "linkedin");
}
{
  const p = firstPostFor(job({ keyword: undefined, location: "", status: "draft", primaryRecruiterId: undefined }), 1);
  eq("no keyword: no alias", p.aliasKeywords, []);
  eq("no location: no place", [p.city, p.country], [null, null]);
  eq("a draft opening's post is a draft", p.status, "draft");
  eq("no recruiter yet: unassigned", p.assignedTaId, null);
}

const post = (id: string, openingId: string, title: string, extra: Partial<RoutablePost> = {}): RoutablePost => ({
  id, openingId, title, previousTitles: [], aliasKeywords: [], city: null, country: "Sri Lanka",
  channel: "linkedin", campaignCode: "", externalUrl: null, postedAt: 0, status: "live", ...extra,
});

console.log("\nthe live poller's routing");
const posts = [
  post("p1", "op_apex", "Head of Finance", { status: "draft" }),
  post("p2", "op_sq", "Head of Finance", { postedAt: 5 }),
  post("p3", "op_mkt", "Head of Marketing", { previousTitles: ["GM Marketing"], aliasKeywords: ["Assistant Manager Digital Marketing"] }),
];
{
  const r = routeShared({ subject: "New application: Head of Finance from Nimal Perera", linkedinOnly: true }, posts);
  eq("a draft post still takes applicants", [r?.openingId, r?.alsoTo.map((a) => a.openingId)].flat().sort(), ["op_apex", "op_sq"]);
}
{
  const r = routeShared({ subject: "New application: GM Marketing from A B", linkedinOnly: true }, posts);
  eq("the title before the TA renamed the advert", r?.openingId, "op_mkt");
  const k = routeShared({ subject: "New application: Assistant Manager Digital Marketing from A B", linkedinOnly: true }, posts);
  eq("an alias the TA added", [k?.openingId, k?.confidence], ["op_mkt", "keyword"]);
}
{
  const r = routeShared({ subject: "New application: Finance Executive from A B", linkedinOnly: true }, posts);
  eq("a near title is not a match — nothing is guessed", r, null);
  const r2 = routeShared({ subject: "CV for any suitable vacancy", linkedinOnly: false }, posts);
  eq("no title at all goes to the database", r2, null);
}

console.log("\nthe LinkedIn Recruiter project number");
// The "View applicant" button of a real application email (22 September).
const viewApplicant =
  "https://www.linkedin.com/talent/redirect/batchReview?project=1528413625&status=applicants&contractId=462248986&profile=AEMAAEafLzABhOh3321IuYHQ_r3fBMKBEqPdEbg&rightRail=jobApplication&trk=eml-email_ent_job_post_new_applicant-null-0-null";
eq("from the View applicant link", linkedinProjectId(viewApplicant), "1528413625");
eq("from the project's own page", linkedinProjectId("https://www.linkedin.com/talent/hire/1528413625/overview"), "1528413625");
eq("from an HTML body (&amp;)", linkedinProjectId(`<a href="https://www.linkedin.com/talent/redirect/batchReview?status=applicants&amp;project=1528413625&amp;x=1">View applicant</a>`), "1528413625");
eq(
  "from a URL-encoded tracking wrapper",
  linkedinProjectId(`https://safe.example/?url=${encodeURIComponent(viewApplicant)}`),
  "1528413625",
);
eq("not from a public job link", linkedinProjectId("https://www.linkedin.com/jobs/view/4012345678"), null);
eq("nothing in plain text", linkedinProjectId("Your job has a new applicant"), null);
{
  const withProject = [
    ...posts,
    post("p9", "op_dev", "AI-Powered Full Stack Application Developer (Intern)", {
      externalUrl: "https://www.linkedin.com/talent/hire/1528413625/overview",
    }),
  ];
  const body = `<p>Your job has a new applicant</p><a href="${viewApplicant.replace(/&/g, "&amp;")}">View applicant</a>`;
  const r = routeShared({ subject: "New application: AI-Powered Full Stack Application Developer from Kawya Warnasuriya", body, linkedinOnly: true }, withProject);
  eq("the project number finds the job, whatever the title says", [r?.openingId, r?.how], ["op_dev", "linkedin_project"]);
  const fwd = routeShared({ subject: "FW: New application: AI-Powered Full Stack Application Developer from Kawya Warnasuriya", body, linkedinOnly: true }, withProject);
  eq("a forwarded application still matches", fwd?.openingId, "op_dev");
  const other = routeShared({ subject: "New application: AI-Powered Full Stack Application Developer from A B", body: body.replace("1528413625", "1999999999"), linkedinOnly: true }, withProject);
  eq("another project's number does not", other, null);
}

console.log("\na job on hold, or a paused advert, is reached by its own link only (5 Oct)");
{
  const link = "https://www.linkedin.com/talent/hire/1528413625/overview";
  const mk = (id: string, openingId: string, extra: Partial<RoutablePost> = {}): RoutablePost => ({
    id, openingId, title: "Head of Finance", previousTitles: [], aliasKeywords: [], channel: "linkedin",
    campaignCode: "", externalUrl: null, postedAt: 0, status: "live", ...extra,
  });
  const onHold = mk("p_hold", "op_hold", { externalUrl: link, status: "paused", linkOnly: true });
  const email = 'New application: Head of Finance from Nimal <a href="https://www.linkedin.com/talent/redirect/batchReview?project=1528413625&amp;a=1">View applicant</a>';
  eq("its link files the applicant there", routeShared({ subject: "New application: Head of Finance from Nimal", body: email, linkedinOnly: true }, [onHold])?.postId, "p_hold");
  eq("its title alone does not", routeShared({ subject: "New application: Head of Finance from Nimal", linkedinOnly: true }, [onHold]), null);
  const live = mk("p_live", "op_live");
  eq("the title goes to the live advert, never the one on hold", routeShared({ subject: "New application: Head of Finance from Nimal", linkedinOnly: true }, [onHold, live])?.postId, "p_live");
  const liveSameLink = mk("p_live2", "op_live", { externalUrl: link, postedAt: -1 });
  eq("a live advert with the same link wins over the paused one", routeShared({ subject: "x", body: email, linkedinOnly: true }, [onHold, liveSameLink])?.postId, "p_live2");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
