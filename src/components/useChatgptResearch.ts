"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { changeWorkday } from "@/app/workday/actions";
import { RESEARCH_LINK_EVENT, saveConfirmedResearchLink, type ResearchLinkChange, type ResearchLinkState } from "@/lib/chatgptResearchSync";

/** Page-local draft sharing; only a successful backend save confers confirmation. */
export function useChatgptResearch(jobId: string, initialLink = "", persist = true) {
  const [state, setState] = useState<ResearchLinkState>({ link: initialLink, confirmed: false, saving: false, message: "" });
  const stateRef = useRef(state);
  const dirty = useRef(false);
  const lastRemote = useRef<string | null>(null);
  const scopedJob = useRef(jobId);
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (scopedJob.current === jobId) return;
    scopedJob.current = jobId;
    dirty.current = false;
    lastRemote.current = null;
    const next = { link: initialLink, confirmed: false, saving: false, message: "" };
    stateRef.current = next;
    setState(next);
  }, [jobId, initialLink]);
  const apply = useCallback((next: ResearchLinkState) => {
    stateRef.current = next;
    if (next.confirmed) { dirty.current = false; lastRemote.current = next.link; }
    else dirty.current = true;
    setState(next);
  }, []);
  const publish = useCallback((next: ResearchLinkState) => {
    if (scopedJob.current === jobId) apply(next);
    window.dispatchEvent(new CustomEvent<ResearchLinkChange>(RESEARCH_LINK_EVENT, { detail: { jobId, state: next } }));
  }, [jobId, apply]);
  useEffect(() => {
    const changed = (event: Event) => {
      const change = (event as CustomEvent<ResearchLinkChange>).detail;
      if (change?.jobId === jobId) apply(change.state);
    };
    window.addEventListener(RESEARCH_LINK_EVENT, changed);
    return () => window.removeEventListener(RESEARCH_LINK_EVENT, changed);
  }, [jobId, apply]);
  const edit = useCallback((link: string) => {
    if (stateRef.current.saving) return;
    publish({ link, confirmed: false, saving: false, message: "" });
  }, [publish]);
  const restoreDraft = useCallback((link: string) => {
    // Restoring an old local draft must not replace a link saved by the other editor.
    if (!dirty.current && !stateRef.current.confirmed) {
      const next = { link, confirmed: false, saving: false, message: "" };
      stateRef.current = next;
      setState(next);
    }
  }, []);
  const adoptSaved = useCallback((link: string) => {
    const previous = lastRemote.current;
    if (previous === link || stateRef.current.saving) return;
    lastRemote.current = link;
    // Ignore stale polling while typing; accept a genuinely new backend save.
    if (dirty.current && previous === null) return;
    apply({ link, confirmed: true, saving: false, message: "" });
  }, [apply]);
  const confirm = useCallback((checked: boolean) => {
    if (stateRef.current.saving) return;
    if (!checked) { edit(stateRef.current.link); return; }
    if (!persist) { apply({ ...stateRef.current, confirmed: true }); return; }
    const link = stateRef.current.link;
    startTransition(async () => {
      const saved = await saveConfirmedResearchLink(jobId, link, changeWorkday, publish);
      if (saved) window.dispatchEvent(new Event("workday-changed"));
    });
  }, [jobId, persist, edit, apply, publish]);
  return { ...state, edit, confirm, restoreDraft, adoptSaved };
}
