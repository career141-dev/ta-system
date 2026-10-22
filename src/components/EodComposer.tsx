"use client";
import { excelFilename as buildExcelFilename } from "@/lib/excelFilename";
import { EodJobChecks } from "./Workday";
import { useChatgptResearch } from "./useChatgptResearch";

import { useCallback, useEffect, useState, useRef } from "react";
import {
  SHORTLIST_COLUMNS,
  boxOverrides,
  eodDetailChanges,
  parseAddressList,
  validateResearchLink,
  type EffortRow,
  type ShortlistRow,
} from "@/lib/eod-format";
import { EffortSheet } from "./EffortSheet";
import { inputClass } from "./form";
import { resendEod, sendEod, sendDailyEmail, saveMiddayDraft } from "@/app/actions";
import type { SubmissionType } from "@/lib/dailyEmail";
import { SubmitButton } from "./Submit";
import { PreparedCvEditor } from "./PreparedCvEditor";
import { applyCandidateDraft, candidateDraftBases, candidateDraftsFromFields, decodeEodBrowserDraft, editCandidateDraft, encodeEodBrowserDraft, eodDraftKeys, type CandidateDraft } from "@/lib/eodDraft";
import type { WorkingStage } from "@/data/types";

function noteLineToHtml(line: string): string {
  let l = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const highlightStyle =
    "background-color:#fef08a;color:#171c18;font-weight:600;padding:1px 4px;border-radius:3px;display:inline-block;";

  l = l.replace(/==([^=]+)==/g, `<mark style="${highlightStyle}">$1</mark>`);
  l = l.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  l = l.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");

  return l;
}

function notesToEditorHtml(notes: string[]): string {
  if (!notes || notes.length === 0) return "";
  return notes
    .map((l) => (l ? `<div>${noteLineToHtml(l)}</div>` : `<div><br></div>`))
    .join("");
}

function domNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === "br") return "\n";

  let inner = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    inner += domNodeToMarkdown(el.childNodes[i]);
  }

  const isMark =
    tag === "mark" ||
    el.style.backgroundColor === "rgb(254, 240, 138)" ||
    el.style.backgroundColor === "#fef08a" ||
    el.style.backgroundColor.includes("yellow") ||
    el.getAttribute("data-highlight") === "true";

  const isBold =
    tag === "b" ||
    tag === "strong" ||
    el.style.fontWeight === "bold" ||
    el.style.fontWeight === "700" ||
    el.style.fontWeight === "600";

  const isItalic = tag === "i" || tag === "em" || el.style.fontStyle === "italic";

  let res = inner;
  if (isMark && res.trim()) {
    res = `==${res.replace(/^==|==$/g, "")}==`;
  }
  if (isBold && res.trim()) {
    res = `**${res.replace(/^\*\*|\*\*$/g, "")}**`;
  }
  if (isItalic && res.trim()) {
    res = `*${res.replace(/^\*|\*$/g, "")}*`;
  }

  if (tag === "div" || tag === "p" || tag === "li") {
    return `\n${res}\n`;
  }

  return res;
}

function editorHtmlToNotes(el: HTMLElement): string[] {
  let text = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    text += domNodeToMarkdown(el.childNodes[i]);
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const HIGHLIGHT_STYLE =
  "background-color:#fef08a;color:#171c18;font-weight:600;padding:1px 4px;border-radius:3px;display:inline-block;";

function createMarkElement(content?: string | Node | DocumentFragment): HTMLElement {
  const mark = document.createElement("mark");
  mark.setAttribute("style", HIGHLIGHT_STYLE);
  if (typeof content === "string") {
    mark.textContent = content;
  } else if (content) {
    mark.appendChild(content);
  }
  return mark;
}

function isHighlightElement(node: Node | null): node is HTMLElement {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "mark") return true;
  const bg = el.style?.backgroundColor;
  if (bg && (bg.includes("254, 240, 138") || bg.includes("fef08a") || bg.includes("yellow"))) {
    return true;
  }
  return el.getAttribute("data-highlight") === "true";
}

function findHighlightAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (isHighlightElement(cur)) return cur as HTMLElement;
    cur = cur.parentNode;
  }
  return null;
}

function getIntersectingHighlightElements(root: HTMLElement, range: Range): HTMLElement[] {
  const highlights = new Set<HTMLElement>();

  const startMark = findHighlightAncestor(range.startContainer, root);
  if (startMark) highlights.add(startMark);

  const endMark = findHighlightAncestor(range.endContainer, root);
  if (endMark) highlights.add(endMark);

  const commonMark = findHighlightAncestor(range.commonAncestorContainer, root);
  if (commonMark) highlights.add(commonMark);

  const allMarks = root.querySelectorAll("mark, [data-highlight='true'], [style*='background-color']");
  allMarks.forEach((el) => {
    if (isHighlightElement(el)) {
      try {
        if (range.intersectsNode(el)) {
          highlights.add(el as HTMLElement);
        }
      } catch {
        // ignore
      }
    }
  });

  return Array.from(highlights);
}

function unwrapElement(el: HTMLElement) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

function EodNotesEditor({
  appId,
  notes,
  onChange,
}: {
  appId: string;
  notes: string[];
  onChange: (notes: string[]) => void;
  className?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const notesStr = Array.isArray(notes) ? notes.join("\n") : String(notes ?? "");

  // Initialize and sync HTML content when notes change externally
  useEffect(() => {
    if (!editorRef.current) return;
    const currentNotes = editorHtmlToNotes(editorRef.current).join("\n");
    if (currentNotes !== notesStr) {
      editorRef.current.innerHTML = notesToEditorHtml(
        Array.isArray(notes) ? notes : notesStr.split("\n")
      );
    }
  }, [notesStr, notes]);

  const sync = () => {
    if (!editorRef.current) return;
    const parsedNotes = editorHtmlToNotes(editorRef.current);
    onChange(parsedNotes);
  };

  const highlightSelection = () => {
    if (!editorRef.current) return;
    editorRef.current.focus();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      document.execCommand(
        "insertHTML",
        false,
        `<mark style="${HIGHLIGHT_STYLE}">highlighted point</mark>&nbsp;`
      );
      sync();
      return;
    }

    const range = sel.getRangeAt(0);
    const root = editorRef.current;

    // Find all highlight elements that intersect or contain the range
    const intersectingHighlights = getIntersectingHighlightElements(root, range);

    if (intersectingHighlights.length > 0) {
      // TOGGLE OFF: Remove highlight from all intersecting highlight elements
      intersectingHighlights.forEach((markEl) => {
        unwrapElement(markEl);
      });
      root.normalize();
      sync();
      return;
    }

    // TOGGLE ON: Apply highlight to selection
    try {
      const frag = range.extractContents();
      const hasBlocks = Array.from(frag.childNodes).some(
        (n) => n.nodeType === Node.ELEMENT_NODE && (n.nodeName === "DIV" || n.nodeName === "P" || n.nodeName === "LI")
      );

      if (hasBlocks) {
        // Multi-line selection: wrap inline content of each block line
        Array.from(frag.childNodes).forEach((child) => {
          if (child.nodeType === Node.ELEMENT_NODE && (child.nodeName === "DIV" || child.nodeName === "P" || child.nodeName === "LI")) {
            const mark = createMarkElement();
            while (child.firstChild) {
              mark.appendChild(child.firstChild);
            }
            child.appendChild(mark);
          } else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
            const mark = createMarkElement(child.textContent);
            frag.replaceChild(mark, child);
          }
        });
        range.insertNode(frag);
      } else {
        // Single line inline selection
        const mark = createMarkElement(frag);
        range.insertNode(mark);
        sel.removeAllRanges();
        const newRange = document.createRange();
        newRange.selectNodeContents(mark);
        sel.addRange(newRange);
      }
    } catch {
      document.execCommand("hiliteColor", false, "#fef08a");
    }

    root.normalize();
    sync();
  };

  const boldSelection = () => {
    if (editorRef.current) editorRef.current.focus();
    document.execCommand("bold");
    sync();
  };

  const insertBullet = () => {
    if (editorRef.current) editorRef.current.focus();
    document.execCommand("insertText", false, "> ");
    sync();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      highlightSelection();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      boldSelection();
    }
  };

  return (
    <div className="flex flex-col gap-1 w-full min-w-[270px]">
      {/* Mini formatting toolbar */}
      <div className="flex items-center gap-1 px-0.5 py-0.5 text-[10.5px]">
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            highlightSelection();
          }}
          title="Highlight selected text in yellow (Ctrl+H)"
          className="flex items-center gap-1 rounded bg-amber-100 hover:bg-amber-200 dark:bg-amber-950/70 dark:hover:bg-amber-900 border border-amber-300 dark:border-amber-700 px-2 py-0.5 font-semibold text-amber-950 dark:text-amber-100 transition-colors shadow-2xs cursor-pointer"
        >
          <span className="text-[10px]">🟡</span>
          <span>Highlight</span>
        </button>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            boldSelection();
          }}
          title="Bold selected text (Ctrl+B)"
          className="rounded border border-rule px-1.5 py-0.5 font-bold text-ink-soft hover:bg-paper hover:text-ink transition-colors cursor-pointer"
        >
          𝐁
        </button>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            insertBullet();
          }}
          title="Add > bullet"
          className="rounded border border-rule px-1.5 py-0.5 text-ink-soft hover:bg-paper hover:text-ink transition-colors cursor-pointer"
        >
          › Bullet
        </button>
      </div>

      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={sync}
        onBlur={sync}
        onKeyDown={handleKeyDown}
        data-placeholder="Type notes or select text & click Highlight..."
        className="w-full min-h-[58px] max-h-[120px] overflow-y-auto resize-y p-2 rounded border border-rule/50 hover:border-rule focus:border-brand focus:bg-surface leading-[1.6] text-[12px] text-ink outline-none transition-colors empty:before:content-[attr(data-placeholder)] empty:before:text-ink-faint bg-paper/30 whitespace-pre-wrap break-words"
      />

      {/* Hidden input to ensure form submission always carries the exact serialized notes string */}
      <input type="hidden" form="eod-send" name={`shortlist_${appId}_notes`} value={notesStr} />
    </div>
  );
}

/**
 * The end-of-day email, composed for review.
 *
 * Fully editable: the subject line, greeting/intro message, candidate shortlist
 * table cells (age, notice, notes, current company, designation, current/expected remuneration),
 * L-sheet effort numbers/dates/assignee, and sign-off message can all be edited directly on screen.
 * Edits are kept in this browser's localStorage until sent so nothing is lost on page reload.
 *
 * With `resend`, it is an email already sent, opened from the copy kept for the
 * month (8 Oct): everything starts as it went, the people cannot change, and
 * Send goes to resendEod, which marks the subject REVISED.
 */
export function EodComposer({
  openingId,
  kind,
  subject: initialSubject,
  toName,
  toEmail,
  ccName,
  ccEmail,
  trackedAt,
  eodCc,
  fixedCc,
  canAddRecipients,
  rows: initialRows,
  effort,
  senderName,
  alreadyOut,
  openSetNote,
  needsResearchLink,
  resend,
  submissionType = "eod",
  dailyDraft,
  dailyParentId,
  savedAttachments,
  useDailyEmail = false,
  excelLinksCount,
  openingTitle,
  clientName,
  workLocationName,
  workLocationId,
  actorId,
  allowActivityOnly = false,
  draftDate,
}: {
  draftDate?: string;
  workLocationId?: string;
  actorId?: string;
  allowActivityOnly?: boolean;
  useDailyEmail?: boolean;
  savedAttachments?: import("@/lib/dailyEmail").SavedEmailAttachment[];
  excelLinksCount?: number;
  openingTitle?: string;
  clientName?: string;
  workLocationName?: string;
  submissionType?: SubmissionType;
  dailyDraft?: { id: string; revision: number; fields: Record<string, string> };
  dailyParentId?: string;
  openingId: string;
  kind: "director" | "client";
  subject: string;
  toName: string;
  toEmail: string;
  ccName: string;
  ccEmail: string;
  /** The TA's shortlist-replies inbox. Copied in, and on the reply-to. */
  trackedAt: string | null;
  /** Copied on every end-of-day email (People page). */
  eodCc: string | null;
  /** Always copied on the Director's email; the TA cannot take these off. */
  fixedCc: string[];
  /** The Director's email lets the TA add more To and Cc addresses. */
  canAddRecipients: boolean;
  rows: ShortlistRow[];
  effort: EffortRow;
  senderName: string;
  /** A set is already out and unanswered. Sending a second one would leave two
   *  numbered lists in play and no way to tell which a reply answers. */
  alreadyOut: boolean;
  openSetNote: string | null;
  /** A TA's email to the directors must carry their ChatGPT research link (8 Oct); the server checks it too. */
  needsResearchLink: boolean;
  /** An email already sent, opened from its copy to correct and send again (8 Oct). */
  resend?: {
    copyId: string;
    introText: string;
    outroText: string;
    researchLink: string | null;
    extraTo: string[];
    extraCc: string[];
    removed: string[];
  };
}) {
  const savedFields = dailyDraft?.fields ?? {};
  const midday = submissionType === "midday";
  const browserKeys = eodDraftKeys(openingId, kind, effort.date, actorId, workLocationId, resend?.copyId, draftDate);
  const draftKey = dailyDraft ? `midday-composer:${dailyDraft.id}` : browserKeys.composer;
  const defaultIntro = initialRows.length
    ? "Dear Sir,\n\nPlease find the attached Shortlisted CV for the above-mentioned position"
    : "Dear Sir,\n\nPlease find today's activity for the above-mentioned position.";
  const defaultOutro = `Thank You\nBest Regards,\n\n${senderName}\nExecutive - Talent Acquisition`;

  const [subject, setSubject] = useState(savedFields.subject && savedFields.subject !== savedFields.baseSubject ? savedFields.subject : initialSubject);
  const [introText, setIntroText] = useState(savedFields.introText ?? (resend ? resend.introText : initialRows.length ? defaultIntro : "Dear Sir,\n\nNo new candidates for Director Review. Please find today's activity summary below."));
  const [outroText, setOutroText] = useState(savedFields.outroText ?? (resend ? resend.outroText : defaultOutro));
  // Reuse today's shared workday confirmation. Editing the link clears it;
  // an older local draft cannot confer confirmation.
  const research = useChatgptResearch(openingId, savedFields.chatgptLink ?? resend?.researchLink ?? "", needsResearchLink && !dailyParentId);
  const researchLink = research.link;
  const researchConfirmed = research.confirmed;
  const [jobBlocked, setJobBlocked] = useState(needsResearchLink && !midday && !dailyParentId);
  const [researchTouched, setResearchTouched] = useState(false);
  const researchCheck = validateResearchLink(researchLink);
  const [researchExcused, setResearchExcused] = useState(false);
  const researchRequired = needsResearchLink && (midday || !(researchExcused && !researchLink.trim()));
  const researchBlocked = research.saving || (researchRequired && (!researchCheck.ok || !researchConfirmed));
  const [shortlistDraft, setShortlistDraft] = useState<Record<string, CandidateDraft>>(() => candidateDraftsFromFields(initialRows, savedFields));
  // Added recipients are chips, like skills on LinkedIn: type the address, pick
  // To or Cc, Add (30 Sep). The comma box let a typo sit unnoticed until Send.
  const [extraTo, setExtraTo] = useState<string[]>(savedFields.extraTo !== undefined ? parseAddressList(savedFields.extraTo).ok : resend?.extraTo ?? []);
  const [extraCc, setExtraCc] = useState<string[]>(savedFields.extraCc !== undefined ? parseAddressList(savedFields.extraCc).ok : resend?.extraCc ?? []);
  const [draftAddress, setDraftAddress] = useState("");
  const [addAs, setAddAs] = useState<"to" | "cc">("to");
  const [addressError, setAddressError] = useState<string | null>(null);
  // The desk's own To and Cc can be taken off too (1 Oct); the server leaves
  // off whatever is named here (lib/eod-format eodRecipients).
  const [removed, setRemoved] = useState<string[]>(savedFields.removed !== undefined ? parseAddressList(savedFields.removed).ok : resend?.removed ?? []);
  const [skipAttachments, setSkipAttachments] = useState(savedFields.skipAttachments === "yes");
  const [regenerateAttachments, setRegenerateAttachments] = useState(false);
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const draftRevision = useRef(dailyDraft?.revision ?? 0);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const lastSaved = useRef(JSON.stringify(savedFields));
  const sending = useRef(false);
  const [saveMessage, setSaveMessage] = useState(dailyDraft ? "Draft saved" : "");
  const [saveError, setSaveError] = useState(false);
  const saveCurrentDraft = useCallback(() => {
    if (!dailyDraft) return Promise.resolve(true);
    const form = document.getElementById("eod-send") as HTMLFormElement | null;
    if (!form) return Promise.resolve(false);
    const fields = Object.fromEntries([...new FormData(form)].filter(([key, value]) => typeof value === "string" &&
      /^(subject|introText|outroText|chatgptLink|extraTo|extraCc|removed|skipAttachments|shortlist_.+|effort_.+|target_.+)$/.test(key))) as Record<string, string>;
    fields.baseSubject = initialSubject;
    for (const [key, value] of Object.entries(effort)) if (typeof value !== "object") fields[`base_effort_${key}`] = value == null ? "" : String(value);
    Object.assign(fields, candidateDraftBases(initialRows, fields));
    const serialized = JSON.stringify(fields);
    saveQueue.current = saveQueue.current.then(async previous => {
      if (!previous) return false;
      if (serialized === lastSaved.current) return true;
      setSaveMessage("Saving draft…");
      try {
        const result = await saveMiddayDraft(openingId, dailyDraft.id, draftRevision.current, fields);
        if (!result.ok) throw new Error(result.message);
        draftRevision.current = result.revision;
        lastSaved.current = serialized;
        setSaveMessage("Draft saved");
        return true;
      } catch (e) {
        setSaveError(true);
        setSaveMessage(`${e instanceof Error ? e.message : "Could not save."} Reload before sending.`);
        return false;
      }
    });
    return saveQueue.current;
  }, [dailyDraft?.id, openingId, initialSubject, effort, initialRows]);
  useEffect(() => {
    if (!dailyDraft) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => {
      if (sending.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void saveCurrentDraft(); }, 750);
    };
    document.addEventListener("input", changed);
    document.addEventListener("change", changed);
    document.addEventListener("click", changed);
    return () => { clearTimeout(timer); document.removeEventListener("input", changed); document.removeEventListener("change", changed); document.removeEventListener("click", changed); };
  }, [dailyDraft?.id, saveCurrentDraft]);
  const isOff = (a: string | null | undefined) => !!a && removed.includes(a.toLowerCase());
  const takeOff = (a: string) => setRemoved((prev) => (prev.includes(a.toLowerCase()) ? prev : [...prev, a.toLowerCase()]));
  const putBack = (a: string) => {
    setRemoved((prev) => prev.filter((r) => r !== a));
    // Typed back in by hand while it was off: one chip, not two.
    setExtraTo((prev) => prev.filter((x) => x !== a));
    setExtraCc((prev) => prev.filter((x) => x !== a));
  };
  const nobodyOnTo = canAddRecipients && (!toEmail || isOff(toEmail)) && extraTo.length === 0;

  const onEmail = [toEmail, ccEmail, eodCc, ...fixedCc, trackedAt]
    .filter((a): a is string => !!a && !isOff(a))
    .concat(extraTo, extraCc)
    .map((a) => a.toLowerCase());
  const addAddress = () => {
    const { ok, bad } = parseAddressList(draftAddress);
    if (bad.length) return setAddressError(`${bad.join(", ")} is not an email address.`);
    if (!ok.length) return setAddressError("Type an email address first.");
    const fresh = ok.filter((a) => !onEmail.includes(a));
    if (!fresh.length) return setAddressError(`${ok.join(", ")} is already on this email.`);
    (addAs === "to" ? setExtraTo : setExtraCc)((prev) => [...prev, ...fresh]);
    setDraftAddress("");
    setAddressError(null);
  };
  const removeAddress = (list: "to" | "cc", address: string) =>
    (list === "to" ? setExtraTo : setExtraCc)((prev) => prev.filter((a) => a !== address));

  // Restore draft from localStorage on mount. Nothing is saved until this has
  // run: the save below used to write the page's defaults over the draft first.
  const [restored, setRestored] = useState(false);
  const useSavedResearch = useCallback((link: string) => {
    if (restored) research.adoptSaved(link);
  }, [restored, research.adoptSaved]);
  useEffect(() => {
    setRestored(true);
    if (dailyDraft) return;
    try {
      const saved = decodeEodBrowserDraft(localStorage.getItem(draftKey));
      if (saved) {
        // Only a subject the TA typed, and only while the set and CV count it
        // was typed over still stand: the saved line was the page's own, so a
        // visit before more CVs joined kept "2 CVs" in front of four (28 Sep).
        if (saved.subject !== undefined && saved.subject !== saved.baseSubject && saved.baseSubject === initialSubject) {
          setSubject(saved.subject);
        }
        if (saved.introText !== undefined) setIntroText(saved.introText);
        if (saved.outroText !== undefined) setOutroText(saved.outroText);
        if (typeof saved.researchLink === "string") research.restoreDraft(saved.researchLink);
        if (saved.shortlistDraft !== undefined) setShortlistDraft(saved.shortlistDraft);
        // Saved as the comma text the server reads, before and after the chips.
        if (typeof saved.extraTo === "string") setExtraTo(parseAddressList(saved.extraTo).ok);
        if (typeof saved.extraCc === "string") setExtraCc(parseAddressList(saved.extraCc).ok);
        if (typeof saved.removed === "string") setRemoved(parseAddressList(saved.removed).ok);
        if (typeof saved.skipAttachments === "boolean") setSkipAttachments(saved.skipAttachments);
      }
    } catch {
      /* storage disabled */
    }
  }, [draftKey]);

  // Persist draft to localStorage
  useEffect(() => {
    if (!restored || dailyDraft) return;
    try {
      localStorage.setItem(
        draftKey,
        encodeEodBrowserDraft({
          subject,
          baseSubject: initialSubject,
          introText,
          outroText,
          researchLink,
          shortlistDraft,
          extraTo: extraTo.join(", "),
          extraCc: extraCc.join(", "),
          removed: removed.join(", "),
          skipAttachments,
        }),
      );
    } catch {
      /* storage disabled */
    }
  }, [restored, draftKey, subject, initialSubject, introText, outroText, researchLink, shortlistDraft, extraTo, extraCc, removed, skipAttachments]);

  const updateCandidateField = (appId: string, field: keyof ShortlistRow, value: any) => {
    const row = initialRows.find((b) => b.applicationId === appId);
    setShortlistDraft((prev) => ({ ...prev, [appId]: editCandidateDraft(prev[appId], row, field, value) }));
  };

  const getCandidateRow = (r: ShortlistRow): ShortlistRow => applyCandidateDraft(r, shortlistDraft[r.applicationId]);

  const effectiveRows = initialRows.map(getCandidateRow);
  const [editingBoxAppId, setEditingBoxAppId] = useState<string | null>(null);
  const [boxVersion, setBoxVersion] = useState(0);

  const getQueryOverrides = (r: ShortlistRow) => {
    const base = initialRows.find((b) => b.applicationId === r.applicationId);
    const over = base ? boxOverrides(eodDetailChanges(base, r)) : {};
    const q = new URLSearchParams();
    if ("currentDesignation" in over) q.set("designation", over.currentDesignation ?? "");
    if ("currentCompany" in over) q.set("company", over.currentCompany ?? "");
    if ("currentSalary" in over) q.set("current", over.currentSalary ?? "");
    if ("expectedSalary" in over) q.set("expected", over.expectedSalary ?? "");
    if ("noticePeriod" in over) q.set("notice", over.noticePeriod ?? "");
    if (over.notes) q.set("notes", over.notes.join("\n"));
    return q.toString();
  };

  /** The attachment's preview: the record, plus only what was changed on this page. */
  const previewHref = (r: ShortlistRow) => {
    const saved = !regenerateAttachments && savedAttachments?.find(a => a.applicationId === r.applicationId);
    if (saved && dailyParentId) return `/api/eod/attachment?email=${dailyParentId}&attachment=${saved.id}`;
    const s = getQueryOverrides(r);
    const params = new URLSearchParams(s);
    if (boxVersion > 0) params.set("_v", String(boxVersion));
    const str = params.toString();
    return `/api/prepared-cv/${r.applicationId}${str ? `?${str}` : ""}`;
  };

  const editingRow = editingBoxAppId
    ? effectiveRows.find((r) => r.applicationId === editingBoxAppId) ?? null
    : null;

  const th =
    "whitespace-nowrap border border-rule bg-tag px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-soft";
  const td = "border border-rule px-1.5 py-1 align-top text-[12px]";
  const cellInput =
    "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface transition-colors";

  return (
    <div className="flex flex-col gap-5">
      {dailyDraft && <p role="status" className={saveError ? "text-sm text-danger" : "text-sm text-ink-soft"}>{saveMessage} <button type="button" onClick={() => void saveCurrentDraft()} className="ml-3 text-brand underline">Save draft</button></p>}
      {/* First on the page (9 Oct): at the bottom, under the CV table and the
          attachments, TAs scrolled past it and asked where it was. It belongs to
          the send form through form="eod-send", wherever it sits. */}
      {/* Shown to everyone on the directors' email (9 Oct): an admin or lead may add one
          too; only a TA must. The server already takes a valid link from anyone. */}
      {kind === "director" && (
        <section className="rounded-2xl border border-rule bg-surface p-7 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
          <h3 className="text-[13.5px] font-semibold">
            ChatGPT research link{" "}
            {researchRequired ? (
              <>
                <span className="text-warn" aria-hidden="true">*</span>
                <span className="sr-only">(required)</span>
              </>
            ) : (
              <span className="font-normal text-ink-faint">(optional)</span>
            )}
          </h3>
          {researchExcused && !researchLink.trim() && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Reason submitted in Today’s Checks. A link is excused for this workday.</p>}
          <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-ink-soft">
            Your TA Lead and the directors will open this from the email. In ChatGPT, open today&rsquo;s research
            chat, choose <b>Share</b>, then <b>Create link</b>, and paste that link here. The address in your
            browser&rsquo;s bar is private to you and will not open for them.
          </p>
          <input
            form="eod-send"
            name="chatgptLink"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required={researchRequired}
            value={researchLink}
            disabled={research.saving}
            onChange={(e) => research.edit(e.target.value)}
            onBlur={() => setResearchTouched(true)}
            placeholder="https://chatgpt.com/share/…"
            aria-invalid={researchTouched && !researchCheck.ok}
            aria-describedby="research-help"
            className={`${inputClass} mt-3`}
          />
          <div id="research-help" className="mt-2 min-h-[18px] text-[12px]" aria-live="polite">
            {researchCheck.ok ? (
              <span className="text-brand">✓ A share link: {researchCheck.url.replace("https://", "")}</span>
            ) : (
              (researchTouched || researchLink.trim() !== "") && <span className="text-warn">{researchCheck.reason}</span>
            )}
          </div>
          <label className="mt-3 flex max-w-[68ch] items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
            <input
              form="eod-send"
              type="checkbox"
              name="researchConfirmed"
              required={researchRequired}
              checked={researchConfirmed || research.saving}
              disabled={research.saving || !researchCheck.ok}
              onChange={(e) => research.confirm(e.target.checked)}
              className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--brand,#165b42)]"
            />
            <span>
              I opened this link in a private window and it shows my research. It holds no candidate phone numbers,
              emails or CV text, because anyone with the link can read it.
            </span>
          </label>
          <p className={`mt-2 text-xs ${researchConfirmed ? "text-brand" : "text-ink-soft"}`} role="status">{research.message || "Confirming saves this link to Today’s Checks and the EOD email."}</p>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <div className="flex flex-col gap-3 border-b border-rule px-7 py-5">
          <div className="flex flex-col gap-2 text-[12.5px]">
            <div className="flex items-center gap-3">
              <span className="w-[42px] shrink-0 text-ink-faint">From</span>
              <span>{senderName} — your own mailbox</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="w-[42px] shrink-0 pt-1 text-ink-faint">To</span>
              <div className="flex flex-wrap gap-1.5">
                {toEmail && !isOff(toEmail) && (
                  <RecipientChip
                    label={toName && toName !== toEmail ? `${toName} · ${toEmail}` : toEmail}
                    onRemove={canAddRecipients ? () => takeOff(toEmail) : undefined}
                  />
                )}
                {extraTo.map((a) => (
                  <RecipientChip key={a} label={a} added onRemove={() => removeAddress("to", a)} />
                ))}
                {nobodyOnTo && <span className="pt-0.5 text-[12px] text-warn">Nobody yet — add an address as To.</span>}
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="w-[42px] shrink-0 pt-1 text-ink-faint">Cc</span>
              <div className="flex flex-wrap gap-1.5">
                {ccEmail && <RecipientChip label={ccName ? `${ccName} · ${ccEmail}` : ccEmail} />}
                {eodCc && <RecipientChip label={eodCc} />}
                {fixedCc
                  .filter((a) => !isOff(a))
                  .map((a) => (
                    <RecipientChip key={a} label={a} onRemove={canAddRecipients ? () => takeOff(a) : undefined} />
                  ))}
                {trackedAt && !isOff(trackedAt) && (
                  <RecipientChip
                    label={trackedAt}
                    faint
                    title="Watches for the reply. Taken off Cc, replies still come back to it through Reply-to."
                    onRemove={canAddRecipients ? () => takeOff(trackedAt) : undefined}
                  />
                )}
                {extraCc.map((a) => (
                  <RecipientChip key={a} label={a} added onRemove={() => removeAddress("cc", a)} />
                ))}
                {!ccEmail && !eodCc && fixedCc.every(isOff) && (!trackedAt || isOff(trackedAt)) && extraCc.length === 0 && (
                  <span className="pt-0.5 text-[12px] text-ink-faint">Nobody</span>
                )}
              </div>
            </div>
            {removed.length > 0 && (
              <div className="flex items-start gap-3">
                <span className="w-[42px] shrink-0 pt-1 text-ink-faint">Off</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {removed.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => putBack(a)}
                      aria-label={`Put ${a} back on the email`}
                      title="Put back on the email"
                      className="rounded-full border border-dashed border-rule px-2.5 py-0.5 text-[12px] text-ink-faint line-through decoration-ink-faint/60 transition-colors hover:border-brand hover:text-brand hover:no-underline"
                    >
                      {a}
                    </button>
                  ))}
                  <span className="text-[11.5px] text-ink-faint">Click one to put it back.</span>
                </div>
              </div>
            )}
          </div>
          {trackedAt && (
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              <span className="text-ink-soft">Reply-to</span> {senderName} and {trackedAt} — so the
              reply reaches you as normal and is tracked, whether they press Reply or Reply All.
              Nothing about what they see changes. One box for the whole desk: the subject line
              above already says which client and which role, so the reply places itself.
            </p>
          )}
          {canAddRecipients && (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-[42px] shrink-0 text-[12.5px] text-ink-faint">Add</span>
                <input
                  type="email"
                  value={draftAddress}
                  onChange={(e) => {
                    setDraftAddress(e.target.value);
                    setAddressError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAddress();
                    }
                  }}
                  placeholder="name@company.com"
                  aria-label="Email address to add"
                  className={`${inputClass} min-w-[200px] flex-1`}
                />
                <div role="radiogroup" aria-label="Add as" className="flex overflow-hidden rounded-full border border-rule">
                  {(["to", "cc"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={addAs === k}
                      onClick={() => setAddAs(k)}
                      className={`px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                        addAs === k ? "bg-ink text-white" : "text-ink-soft hover:bg-paper"
                      }`}
                    >
                      {k === "to" ? "To" : "Cc"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addAddress}
                  className="rounded-full border border-brand px-4 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand hover:text-white"
                >
                  Add
                </button>
              </div>
              {addressError && <p className="pl-[50px] text-[11.5px] text-warn">{addressError}</p>}
              {/* What the server reads: the chips as comma lists (actions.ts sendEod). */}
              <input type="hidden" form="eod-send" name="extraTo" value={extraTo.join(", ")} />
              <input type="hidden" form="eod-send" name="extraCc" value={extraCc.join(", ")} />
              <input type="hidden" form="eod-send" name="removed" value={removed.join(", ")} />
            </div>
          )}
          <label className="flex items-center gap-3">
            <span className="text-[12.5px] font-medium text-ink-faint">Subject</span>
            <input
              form="eod-send"
              name="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={`${inputClass} flex-1 font-medium`}
            />
          </label>
        </div>

        <div className="px-7 py-6">
          {/* Editable Salutation / Intro */}
          <div className="mb-4">
            <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint mb-1">
              Introductory Greeting & Message
            </label>
            <textarea
              form="eod-send"
              name="introText"
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              rows={Math.max(2, introText.split("\n").length)}
              className="w-full rounded-lg border border-transparent bg-paper/60 p-2.5 text-[13px] leading-[1.8] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface resize-y transition-colors font-sans"
              placeholder="Dear Sir,&#10;&#10;Please find the attached Shortlisted CV..."
            />
          </div>

          {/* Table one — the client snapshot (Fully editable) */}
          <div className="mt-5 overflow-x-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                Candidate Shortlist Table
              </span>
              <span className="text-[11px] text-ink-faint">
                Click any cell to edit · Select text and click <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-700/80 px-1 font-medium text-amber-900 dark:text-amber-200 text-[10.5px]">🟡 Highlight</span> on Notes to emphasize key points
              </span>
            </div>

            {initialRows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-rule px-5 py-8 text-center text-[12.5px] text-ink-faint">
                {kind === "director"
                  ? "Nobody is ready to go yet — a candidate is ready once their follow-up questions are all answered, or they are in Director Review."
                  : "Nobody is in Client Review yet — move candidates to Client Review to include them in the submission."}
              </p>
            ) : (
              <>
                {(() => {
                  const empty = [
                    ["AGE", effectiveRows.every((r) => !String(r.age ?? "").trim())],
                    ["NOTICE", effectiveRows.every((r) => !String(r.notice ?? "").trim())],
                    ["NOTES", effectiveRows.every((r) => !Array.isArray(r.notes) ? !String(r.notes).trim() : r.notes.every((n) => !n.trim()))],
                    ["CURRENT REMUNERATION", effectiveRows.every((r) => !String(r.currentRemuneration ?? "").trim())],
                    ["EXPECTED REMUNERATION", effectiveRows.every((r) => !String(r.expectedRemuneration ?? "").trim())],
                  ]
                    .filter(([, e]) => e)
                    .map(([h]) => h as string);
                  return empty.length > 0 ? (
                    <p className="mb-3 rounded-lg bg-warn-soft px-3.5 py-2 text-[12px] text-warn">
                      {empty.join(", ")} {empty.length === 1 ? "is" : "are"} empty for everyone in this set. You can type them into the table cells below before sending.
                    </p>
                  ) : null;
                })()}
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      {SHORTLIST_COLUMNS.map((h) => (
                        <th key={h} className={th}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {effectiveRows.map((r) => {
                      return (
                        <tr key={r.applicationId} className="hover:bg-paper/30 transition-colors">
                          <td className={`${td} tabular font-medium text-ink-faint text-center pt-2.5`}>
                            {r.no}
                          </td>
                          <td className={`${td} min-w-[140px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_name`}
                              value={r.name}
                              onChange={(e) => updateCandidateField(r.applicationId, "name", e.target.value)}
                              className={`${cellInput} font-semibold`}
                            />
                            <div className="mt-1 flex items-center gap-1.5 px-1.5">
                              <button
                                type="button"
                                onClick={() => setEditingBoxAppId(r.applicationId)}
                                className="inline-flex items-center gap-1 rounded bg-brand/10 hover:bg-brand/20 border border-brand/25 px-1.5 py-0.5 text-[10.5px] font-semibold text-brand transition-colors cursor-pointer shadow-2xs"
                                title="Move green Career141 box on page 1 of the CV"
                              >
                                <span className="inline-block h-2 w-2 rounded-xs bg-brand" />
                                <span>Move Green Box</span>
                              </button>
                            </div>
                          </td>
                          <td className={`${td} w-[65px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_age`}
                              value={r.age}
                              onChange={(e) => updateCandidateField(r.applicationId, "age", e.target.value)}
                              className={`${cellInput} tabular-nums`}
                            />
                          </td>
                          <td className={`${td} min-w-[95px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_notice`}
                              value={r.notice}
                              onChange={(e) => updateCandidateField(r.applicationId, "notice", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[260px]`}>
                            <EodNotesEditor
                              appId={r.applicationId}
                              notes={r.notes}
                              onChange={(n) => updateCandidateField(r.applicationId, "notes", n)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[140px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_currentCompany`}
                              value={r.currentCompany}
                              onChange={(e) => updateCandidateField(r.applicationId, "currentCompany", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[140px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_currentDesignation`}
                              value={r.currentDesignation}
                              onChange={(e) => updateCandidateField(r.applicationId, "currentDesignation", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[130px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_currentRemuneration`}
                              value={r.currentRemuneration}
                              onChange={(e) => updateCandidateField(r.applicationId, "currentRemuneration", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                          <td className={`${td} min-w-[130px]`}>
                            <input
                              form="eod-send"
                              name={`shortlist_${r.applicationId}_expectedRemuneration`}
                              value={r.expectedRemuneration}
                              onChange={(e) => updateCandidateField(r.applicationId, "expectedRemuneration", e.target.value)}
                              className={cellInput}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* Table two — the L-sheet, editable before it goes */}
          <div className="mt-8">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
                L-Sheet Daily Effort Table
              </span>
              <span className="text-[11px] text-ink-faint">
                Edit outreach counts, targets, stage, date & assignee
              </span>
            </div>
            <EffortSheet
              savedFields={dailyDraft?.fields}
              effort={effort}
              formId="eod-send"
              draftKey={dailyDraft ? `midday-effort:${dailyDraft.id}` : browserKeys.effort}
              openingId={openingId}
            />
          </div>

          {/* Editable Sign-off / Outro */}
          <div className="mt-8">
            <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint mb-1">
              Sign-off & Closing
            </label>
            <textarea
              form="eod-send"
              name="outroText"
              value={outroText}
              onChange={(e) => setOutroText(e.target.value)}
              rows={Math.max(3, outroText.split("\n").length)}
              className="w-full rounded-lg border border-transparent bg-paper/60 p-2.5 text-[13px] leading-[1.8] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface resize-y transition-colors font-sans"
              placeholder="Thank You&#10;Best Regards,&#10;&#10;..."
            />
          </div>
        </div>
      </section>

      {(() => {
        const hasExcelAttachment = submissionType === "eod" && !skipAttachments && (excelLinksCount ?? 0) > 0;
        const excelFilename = buildExcelFilename(clientName || "Client", openingTitle || "Position", workLocationName);
        const totalAttachments = (skipAttachments ? 0 : effectiveRows.length) + (hasExcelAttachment ? 1 : 0);

        return (
          <section className="rounded-2xl border border-rule bg-surface p-7 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[13.5px] font-semibold">
                Attachments <span className="ml-1.5 font-normal text-[12px] text-ink-faint">{totalAttachments}</span>
              </h2>
              {midday && (
                <label className="flex items-center gap-2 cursor-pointer text-[12.5px] text-ink select-none">
                  <input
                    type="checkbox"
                    checked={skipAttachments}
                    onChange={(e) => setSkipAttachments(e.target.checked)}
                    className="h-4 w-4 rounded border-rule text-brand focus:ring-brand"
                  />
                  <span className="font-medium">Send without CV attachments</span>
                </label>
              )}
            </div>
            {midday && (
              <input type="hidden" form="eod-send" name="skipAttachments" value={skipAttachments ? "yes" : "no"} />
            )}
            {skipAttachments ? (
              <div className="mt-3 rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 p-3.5 text-[12px] leading-relaxed text-ink-soft">
                <span className="font-semibold text-ink">CV attachments skipped:</span> This midday email will be sent with no PDF attachments. The candidate table and effort summary will still be included. Explain the reason in the email body or notes.
              </div>
            ) : effectiveRows.length === 0 && !hasExcelAttachment ? (
              <p className="mt-2 text-[12.5px] text-ink-faint">Nothing to attach.</p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {effectiveRows.map((r) => {
                  const saved = !regenerateAttachments && savedAttachments?.find(a => a.applicationId === r.applicationId);
                  if (saved && dailyParentId) return <a key={r.applicationId} href={previewHref(r)} target="_blank" rel="noreferrer" className="rounded-xl border border-rule px-3.5 py-2.5 text-sm text-brand underline">View saved PDF · {saved.name}</a>;
                  return (
                    <button
                      key={r.applicationId}
                      type="button"
                      onClick={() => setEditingBoxAppId(r.applicationId)}
                      className="group flex w-full items-center justify-between gap-3 rounded-xl border border-rule/70 bg-paper/40 px-3.5 py-2.5 hover:border-brand/40 hover:bg-brand/5 transition-all text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint border border-rule group-hover:border-brand/30 group-hover:text-brand transition-colors">
                          PDF
                        </span>
                        <span className="text-[12.5px] font-medium text-brand group-hover:underline">
                          {r.name} - Career141.pdf
                        </span>
                      </div>
                      <span className="text-[11px] text-ink-faint group-hover:text-brand transition-colors">
                        Click to view &amp; position box →
                      </span>
                    </button>
                  );
                })}
                {hasExcelAttachment && (
                  <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-rule/70 bg-paper/40 px-3.5 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                        XLSX
                      </span>
                      <span className="truncate text-[12.5px] font-medium text-ink">
                        {excelFilename}
                      </span>
                      <span className="hidden sm:inline text-[11.5px] text-ink-faint">
                        ({excelLinksCount} candidate link{excelLinksCount === 1 ? "" : "s"} with clickable LinkedIn URLs)
                      </span>
                    </div>
                    <a
                      href={`/api/openings/${openingId}/links/export?all=1${workLocationId ? `&location=${encodeURIComponent(workLocationId)}` : ""}`}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-[11.5px] font-medium text-brand hover:underline"
                    >
                      Preview workbook →
                    </a>
                  </div>
                )}
              </div>
            )}
            {!skipAttachments && (effectiveRows.length > 0 || hasExcelAttachment) && (
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
                {effectiveRows.length > 0 && "Each CV carries the green CAREER141 block on page one with your edited remuneration and notes stamped on top."}
                {effectiveRows.length > 0 && hasExcelAttachment && " "}
                {hasExcelAttachment && "The attached Excel Tables workbook separates each TA’s levels into tabs, with Interested, Pending and Not Interested sections and clickable profile links."}
              </p>
            )}
          </section>
        );
      })()}

      {needsResearchLink && !midday && !dailyParentId && <EodJobChecks jobId={openingId} locationScoped={allowActivityOnly} linkConfirmed={researchCheck.ok && researchConfirmed} revised={!!resend} onBlocked={setJobBlocked} onResearchSaved={useSavedResearch} onResearchExcused={setResearchExcused}
        extraReasons={[
          ...(nobodyOnTo ? [{ key: "recipient", message: "Add a valid email address on the To line." }] : []),
          ...(researchBlocked ? [{ key: "chatgpt", message: "Add a valid ChatGPT share link and confirm it, or submit a reason in Today’s Checks." }] : []),
        ]} />}
      {dailyParentId && <div className="mb-4 space-y-2 text-sm">
        <label className="block"><input form="eod-send" type="checkbox" name="regenerateAttachments" value="yes" checked={regenerateAttachments} onChange={e => setRegenerateAttachments(e.target.checked)} /> Replace saved CV attachments with newly prepared CVs using the current records and edits above</label>
        <p className="text-xs text-ink-soft">Saved PDFs are reused unless you select replacement. Older backups without saved PDFs use the current prepared CVs.</p>
        <label className="block"><input form="eod-send" type="checkbox" name="previewConfirmed" required checked={previewConfirmed} onChange={e => setPreviewConfirmed(e.target.checked)} /> I reviewed this revised email, its recipients and attachments.</label>
      </div>}
      <form id="eod-send" action={async data => {
        sending.current = true;
        try {
          // Keep the last rendered values before navigation. The old submit
          // listener deleted this draft before server validation, so Age,
          // Current Company and Current Designation (and every other edit)
          // disappeared whenever validation or attachment preparation failed.
          if (!dailyDraft) {
            try {
              localStorage.setItem(draftKey, encodeEodBrowserDraft({
                subject,
                baseSubject: initialSubject,
                introText,
                outroText,
                researchLink,
                shortlistDraft,
                extraTo: extraTo.join(", "),
                extraCc: extraCc.join(", "),
                removed: removed.join(", "),
                skipAttachments,
              }));
            } catch {
              /* storage disabled; the form can still be submitted */
            }
          }
          if (dailyDraft && !await saveCurrentDraft()) return;
          if (dailyDraft) data.set("dailyDraftRevision", String(draftRevision.current));
          await (dailyDraft || dailyParentId || (useDailyEmail && kind === "director" && !resend) ? sendDailyEmail : resend ? resendEod : sendEod)(data);
        } finally { sending.current = false; }
      }} className="flex flex-wrap items-center gap-4">
        <input type="hidden" name="submissionType" value={submissionType} />
        {dailyDraft && <input type="hidden" name="dailyDraftId" value={dailyDraft.id} />}
        {dailyParentId && <input type="hidden" name="dailyParentId" value={dailyParentId} />}
        {!resend && kind === "director" && initialRows.length === 0 && <input type="hidden" name="activityOnly" value="yes" />}
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="workLocationId" value={workLocationId ?? ""} />
        {resend && <input type="hidden" name="copyId" value={resend.copyId} />}
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="to" value={toEmail} />
        {/* The order here is the order they are numbered in the table, which is
            the order the reply's numbers will refer to. */}
        <input
          type="hidden"
          name="applicationIds"
          value={initialRows.map((r) => r.applicationId).join(",")}
        />
        {/* Busy from the first press (6 Oct): the plain button showed nothing
            while the CVs were stamped and the mail sent, so TAs pressed it
            again and again — each press another send. */}
        <SubmitButton
          disabled={(initialRows.length === 0 && kind !== "director") || nobodyOnTo || researchBlocked || (researchRequired && jobBlocked) || saveError || (!!dailyParentId && !previewConfirmed)}
          title={
            initialRows.length === 0 && kind !== "director"
              ? "Add at least one CV in Director Review before sending"
              : nobodyOnTo
              ? "Add an address as To first"
              : researchBlocked
                ? "Add your ChatGPT research link and tick the box first"
                : undefined
          }
          pendingLabel={kind === "director" ? "Sending… this can take a minute" : "Recording…"}
          className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35 shadow-sm"
        >
          {resend ? "Send again as REVISED" : kind === "director" ? initialRows.length === 0 ? "Send activity email" : "Send email" : "Record that it went to the client"}
        </SubmitButton>
        {kind === "director" && (
          <span className="text-[11.5px] text-ink-faint">
            {resend
              ? "Press once — it goes to the same people, with the same CVs, numbered as before."
              : initialRows.length ? "Press once — the CVs are stamped and attached before it goes." : "Press once — the email includes today's activity."}
          </span>
        )}
      </form>

      {/* ── Modal Dialog for Positioning Green Box on Prepared CV ── */}
      {editingRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setEditingBoxAppId(null);
              setBoxVersion((v) => v + 1);
            }
          }}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-[1020px] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="eod-box-editor-title"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/10 text-[12px] font-bold text-brand">
                  CV
                </span>
                <div>
                  <h3 id="eod-box-editor-title" className="text-[14px] font-semibold text-ink">
                    Position Green Box — {editingRow.name}
                  </h3>
                  <p className="text-[11.5px] text-ink-faint">
                    Drag the green box or use arrow keys to position it. Dropping it saves automatically for the EOD email attachment.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingBoxAppId(null);
                  setBoxVersion((v) => v + 1);
                }}
                className="rounded-lg bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 cursor-pointer shadow-xs"
              >
                Done
              </button>
            </div>

            {/* Modal Body with PreparedCvEditor */}
            <div className="flex-1 overflow-y-auto p-5 bg-paper/40">
              <PreparedCvEditor
                appId={editingRow.applicationId}
                openingId={openingId}
                pdfSrc={editingRow.pdfSrc ?? null}
                queryOverrides={getQueryOverrides(editingRow)}
                canEdit={true}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One address on the To or Cc line; an × when it can be taken off. */
function RecipientChip({
  label,
  added,
  faint,
  title,
  onRemove,
}: {
  label: string;
  added?: boolean;
  faint?: boolean;
  title?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] ${
        added ? "border-brand/40 bg-brand/5 text-ink" : "border-rule bg-tag text-ink-soft"
      } ${faint ? "text-ink-faint" : ""}`}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="-mr-1 ml-0.5 rounded-full px-1 leading-none text-ink-faint hover:bg-paper hover:text-ink"
        >
          ×
        </button>
      )}
    </span>
  );
}
