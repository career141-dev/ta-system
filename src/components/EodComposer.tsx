"use client";

import { useEffect, useState, useRef } from "react";
import { SHORTLIST_COLUMNS, boxOverrides, eodDetailChanges, type EffortRow, type ShortlistRow } from "@/lib/eod-format";
import { EffortSheet } from "./EffortSheet";
import { inputClass } from "./form";
import { sendEod } from "@/app/actions";

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
}: {
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
}) {
  const draftKey = `eod-composer-draft:${openingId}:${kind}`;
  const defaultIntro = "Dear Sir,\n\nPlease find the attached Shortlisted CV for the above-mentioned position";
  const defaultOutro = `Thank You\nBest Regards,\n\n${senderName}\nExecutive - Talent Acquisition`;

  const [subject, setSubject] = useState(initialSubject);
  const [introText, setIntroText] = useState(defaultIntro);
  const [outroText, setOutroText] = useState(defaultOutro);
  const [shortlistDraft, setShortlistDraft] = useState<Record<string, Partial<ShortlistRow>>>({});
  const [extraTo, setExtraTo] = useState("");
  const [extraCc, setExtraCc] = useState("");

  // Restore draft from localStorage on mount
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        // Only a subject the TA typed, and only while the set and CV count it
        // was typed over still stand: the saved line was the page's own, so a
        // visit before more CVs joined kept "2 CVs" in front of four (28 Sep).
        if (saved.subject !== undefined && saved.subject !== saved.baseSubject && saved.baseSubject === initialSubject) {
          setSubject(saved.subject);
        }
        if (saved.introText !== undefined) setIntroText(saved.introText);
        if (saved.outroText !== undefined) setOutroText(saved.outroText);
        if (saved.shortlistDraft !== undefined) setShortlistDraft(saved.shortlistDraft);
        if (typeof saved.extraTo === "string") setExtraTo(saved.extraTo);
        if (typeof saved.extraCc === "string") setExtraCc(saved.extraCc);
      }
    } catch {
      /* storage disabled */
    }
  }, [draftKey]);

  // Persist draft to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ subject, baseSubject: initialSubject, introText, outroText, shortlistDraft, extraTo, extraCc }),
      );
    } catch {
      /* storage disabled */
    }
  }, [draftKey, subject, initialSubject, introText, outroText, shortlistDraft, extraTo, extraCc]);

  // Clear draft on send
  useEffect(() => {
    const form = document.getElementById("eod-send");
    const clear = () => {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* storage disabled */
      }
    };
    form?.addEventListener("submit", clear);
    return () => form?.removeEventListener("submit", clear);
  }, [draftKey]);

  const updateCandidateField = (appId: string, field: keyof ShortlistRow, value: any) => {
    setShortlistDraft((prev) => ({
      ...prev,
      [appId]: {
        ...prev[appId],
        [field]: value,
      },
    }));
  };

  const getCandidateRow = (r: ShortlistRow): ShortlistRow => {
    const override = shortlistDraft[r.applicationId] || {};
    return {
      ...r,
      ...override,
      notes: override.notes !== undefined ? override.notes : r.notes,
    };
  };

  const effectiveRows = initialRows.map(getCandidateRow);
  /** The attachment's preview: the record, plus only what was changed on this page. */
  const previewHref = (r: ShortlistRow) => {
    const base = initialRows.find((b) => b.applicationId === r.applicationId);
    const over = base ? boxOverrides(eodDetailChanges(base, r)) : {};
    const q = new URLSearchParams();
    if ("currentSalary" in over) q.set("current", over.currentSalary ?? "");
    if ("expectedSalary" in over) q.set("expected", over.expectedSalary ?? "");
    if ("noticePeriod" in over) q.set("notice", over.noticePeriod ?? "");
    if (over.notes) q.set("notes", over.notes.join("\n"));
    const s = q.toString();
    return `/api/prepared-cv/${r.applicationId}${s ? `?${s}` : ""}`;
  };

  const th =
    "whitespace-nowrap border border-rule bg-tag px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-soft";
  const td = "border border-rule px-1.5 py-1 align-top text-[12px]";
  const cellInput =
    "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-[12px] text-ink outline-none hover:border-rule focus:border-brand focus:bg-surface transition-colors";

  return (
    <div className="flex flex-col gap-5">
      <section className="overflow-hidden rounded-2xl border border-rule bg-surface shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <div className="flex flex-col gap-3 border-b border-rule px-7 py-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-[12.5px]">
            <span>
              <span className="text-ink-faint">From </span>
              {senderName} — your own mailbox
            </span>
            <span>
              <span className="text-ink-faint">To </span>
              {toName} <span className="text-ink-faint">{toEmail}</span>
            </span>
            {ccName && (
              <span>
                <span className="text-ink-faint">Cc </span>
                {ccName} <span className="text-ink-faint">{ccEmail}</span>
              </span>
            )}
            {eodCc && (
              <span>
                <span className="text-ink-faint">Cc </span>
                {eodCc}
              </span>
            )}
            {fixedCc.length > 0 && (
              <span>
                <span className="text-ink-faint">Cc </span>
                {fixedCc.join(", ")}
              </span>
            )}
            {trackedAt && (
              <span>
                <span className="text-ink-faint">Cc </span>
                <span className="text-ink-faint">{trackedAt}</span>
              </span>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-3">
                <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-faint">Also To</span>
                <input
                  form="eod-send"
                  name="extraTo"
                  value={extraTo}
                  onChange={(e) => setExtraTo(e.target.value)}
                  placeholder="more addresses, separated by commas"
                  className={`${inputClass} flex-1`}
                />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-faint">Also Cc</span>
                <input
                  form="eod-send"
                  name="extraCc"
                  value={extraCc}
                  onChange={(e) => setExtraCc(e.target.value)}
                  placeholder="more addresses, separated by commas"
                  className={`${inputClass} flex-1`}
                />
              </label>
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
              effort={effort}
              formId="eod-send"
              draftKey={`eod-effort:${openingId}:${effort.date}`}
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

      <section className="rounded-2xl border border-rule bg-surface p-7 shadow-[0_1px_2px_rgba(23,28,24,0.04)]">
        <h2 className="text-[13.5px] font-semibold">
          Attachments <span className="ml-1.5 font-normal text-[12px] text-ink-faint">{effectiveRows.length}</span>
        </h2>
        {effectiveRows.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-faint">Nothing to attach.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-1.5">
            {effectiveRows.map((r) => {
              return (
                <a
                  key={r.applicationId}
                  // The file that is attached: the Prepared CV as the desk holds
                  // it, with only what the TA changed on this email laid over it
                  // (lib/eod-format boxOverrides, 29 Sep).
                  href={previewHref(r)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2.5 text-[12.5px] text-brand hover:underline"
                >
                  <span className="text-ink-faint">PDF</span>
                  {r.name} - Career141.pdf
                </a>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          Each one carries the green CAREER141 block on page one with your edited remuneration and notes stamped on top.
        </p>
      </section>

      <form id="eod-send" action={sendEod} className="flex flex-wrap items-center gap-4">
        <input type="hidden" name="openingId" value={openingId} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="to" value={toEmail} />
        {/* The order here is the order they are numbered in the table, which is
            the order the reply's numbers will refer to. */}
        <input
          type="hidden"
          name="applicationIds"
          value={initialRows.map((r) => r.applicationId).join(",")}
        />
        <button
          disabled={initialRows.length === 0}
          className="rounded-full bg-brand px-6 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35 shadow-sm"
        >
          {kind === "director" ? "Send email" : "Record that it went to the client"}
        </button>
      </form>
    </div>
  );
}
