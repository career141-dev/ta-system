import { linkedinJobId, linkedinProjectId } from "../../convex/lib/postRouting";
import type { JobPost } from "@/data/types";

/**
 * Whether a job is connected to LinkedIn, for the dashboards (the desk, 30 Sep):
 * the TA Lead sees every TA's jobs and each TA their own, without opening one.
 *
 * "Connected" is what the application routing matches on (convex/lib/
 * postRouting): a LinkedIn post, live or draft, whose link carries a LinkedIn
 * job or Recruiter project number. Every opening starts with a LinkedIn post
 * but no link — matched then by headline alone, which the post screen already
 * warns can send CVs to the wrong job — so that is its own state, not "on".
 */
export type LinkedInStatus = "connected" | "no_link" | "no_post";

export function linkedinStatus(posts: Pick<JobPost, "channel" | "status" | "externalUrl">[]): LinkedInStatus {
  const active = posts.filter((p) => p.channel === "linkedin" && (p.status === "live" || p.status === "draft"));
  if (active.some((p) => linkedinJobId(p.externalUrl) || linkedinProjectId(p.externalUrl))) return "connected";
  return active.length ? "no_link" : "no_post";
}

export const LINKEDIN_STATUS: Record<LinkedInStatus, { label: string; hint: string; tone: string; dot: string }> = {
  connected: {
    label: "On LinkedIn",
    hint: "A LinkedIn post with its job link — applications come straight to this job.",
    tone: "bg-brand-soft text-brand",
    dot: "bg-brand",
  },
  no_link: {
    label: "No LinkedIn link",
    hint: "The LinkedIn post has no job link pasted, so applications are matched by title only and may go to the wrong job.",
    tone: "bg-warn-soft text-warn",
    dot: "bg-warn",
  },
  no_post: {
    label: "Not on LinkedIn",
    hint: "No live LinkedIn post — LinkedIn applications cannot reach this job.",
    tone: "bg-tag text-ink-soft",
    dot: "bg-rule-strong",
  },
};
