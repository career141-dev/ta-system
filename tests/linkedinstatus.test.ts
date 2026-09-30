/**
 * A job's LinkedIn connection on the dashboards (the desk, 30 Sep): connected
 * only when a live or draft LinkedIn post carries a job or Recruiter project
 * link — what the application routing matches on.
 */
import { linkedinStatus } from "@/lib/linkedinStatus";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

type P = Parameters<typeof linkedinStatus>[0][number];
const post = (p: Partial<P>): P => ({ channel: "linkedin", status: "live", externalUrl: null, ...p });
const JOB = "https://www.linkedin.com/jobs/view/4012345678/";
const PROJECT = "https://www.linkedin.com/talent/hire/1234567/discover/applicants";

eq("no posts: not on LinkedIn", linkedinStatus([]), "no_post");
eq("the first post, with no link: no link", linkedinStatus([post({})]), "no_link");
eq("a live post with a job link: connected", linkedinStatus([post({ externalUrl: JOB })]), "connected");
eq("a Recruiter project link counts", linkedinStatus([post({ externalUrl: PROJECT })]), "connected");
eq("a draft with a link counts (routing reads drafts)", linkedinStatus([post({ status: "draft", externalUrl: JOB })]), "connected");
eq("a paused post does not", linkedinStatus([post({ status: "paused", externalUrl: JOB })]), "no_post");
eq("a closed post does not", linkedinStatus([post({ status: "closed", externalUrl: JOB })]), "no_post");
eq("a link with no job number does not", linkedinStatus([post({ externalUrl: "https://www.linkedin.com/company/acme" })]), "no_link");
eq("a portal post is not LinkedIn", linkedinStatus([post({ channel: "portal", externalUrl: JOB })]), "no_post");
eq("one connected post is enough", linkedinStatus([post({}), post({ externalUrl: JOB })]), "connected");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
