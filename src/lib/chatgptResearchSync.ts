import { validateResearchLink } from "./eod-format";

export const RESEARCH_LINK_EVENT = "chatgpt-research-changed";
export interface ResearchLinkState {
  link: string;
  confirmed: boolean;
  saving: boolean;
  message: string;
}
export interface ResearchLinkChange { jobId: string; state: ResearchLinkState }

/** Both editors use the same save operation; confirmation belongs to the exact URL. */
export async function saveConfirmedResearchLink(
  jobId: string,
  link: string,
  save: (form: FormData) => Promise<{ ok: boolean; message: string }>,
  publish: (state: ResearchLinkState) => void,
): Promise<boolean> {
  const checked = validateResearchLink(link);
  if (!checked.ok) {
    publish({ link, confirmed: false, saving: false, message: checked.reason });
    return false;
  }
  publish({ link, confirmed: false, saving: true, message: "Saving research link…" });
  const form = new FormData();
  form.set("op", "saveCheck");
  form.set("kind", "chatgpt");
  form.set("jobId", jobId);
  form.set("link", checked.url);
  form.set("confirmed", "on");
  try {
    const result = await save(form);
    publish({ link: result.ok ? checked.url : link, confirmed: result.ok, saving: false,
      message: result.ok ? "Research link saved. Today’s Checks and the EOD email are updated." : result.message });
    return result.ok;
  } catch {
    publish({ link, confirmed: false, saving: false, message: "Could not save the research link. Confirm it again to retry." });
    return false;
  }
}
