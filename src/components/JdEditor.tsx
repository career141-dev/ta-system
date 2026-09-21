"use client";

import { useRef, useState } from "react";
import { JdDocument } from "./JdDocument";

/**
 * Editing a JD without typing Markdown.
 *
 * Opens on the formatted document; "Edit text" shows the source with buttons
 * for the few forms a JD uses — heading, bold, bullet — so nobody has to know
 * that "##" makes a heading (testing, 21 Sep). The value is still Markdown,
 * because matching, sourcing and the snippet read it.
 */
export function JdEditor({
  name,
  value,
  onChange,
  rows = 18,
  startInSource = false,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  startInSource?: boolean;
}) {
  const [source, setSource] = useState(startInSource);
  const area = useRef<HTMLTextAreaElement | null>(null);

  /** Wrap the selection, or prefix the selected lines. */
  const apply = (kind: "bold" | "heading" | "bullet") => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    let next = value;
    let caret = b;
    if (kind === "bold") {
      const picked = value.slice(a, b) || "bold text";
      next = `${value.slice(0, a)}**${picked}**${value.slice(b)}`;
      caret = a + picked.length + 4;
    } else {
      const start = value.lastIndexOf("\n", a - 1) + 1;
      const endNl = value.indexOf("\n", b);
      const end = endNl === -1 ? value.length : endNl;
      const prefix = kind === "heading" ? "### " : "- ";
      const lines = value
        .slice(start, end)
        .split("\n")
        .map((l) => {
          const bare = l.replace(/^(#{1,6}\s+|[-*•]\s+)/, "");
          return l.startsWith(prefix) ? bare : `${prefix}${bare}`;
        })
        .join("\n");
      next = `${value.slice(0, start)}${lines}${value.slice(end)}`;
      caret = start + lines.length;
    }
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const tool = "rounded-md px-2.5 py-1 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink";

  return (
    <div className="overflow-hidden rounded-xl border border-rule">
      <div className="flex flex-wrap items-center gap-1 border-b border-rule bg-paper/60 px-2 py-1.5">
        {source ? (
          <>
            <button type="button" onClick={() => apply("heading")} className={tool} title="Make the line a section heading">
              Heading
            </button>
            <button type="button" onClick={() => apply("bold")} className={`${tool} font-semibold`} title="Bold the selection">
              B
            </button>
            <button type="button" onClick={() => apply("bullet")} className={tool} title="Make the lines a bullet list">
              • List
            </button>
            <button type="button" onClick={() => setSource(false)} className={`${tool} ml-auto font-medium text-brand`}>
              Done — show formatted
            </button>
          </>
        ) : (
          <>
            <span className="px-2 text-[11.5px] text-ink-faint">As candidates will read it</span>
            <button type="button" onClick={() => setSource(true)} className={`${tool} ml-auto font-medium text-brand`}>
              Edit text
            </button>
          </>
        )}
      </div>
      {/* Always in the form, so the value is sent whichever view is open. */}
      <textarea
        ref={area}
        name={name}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hidden={!source}
        className="block w-full resize-y bg-surface px-4 py-3 font-mono text-[12.5px] leading-relaxed outline-none"
      />
      {!source && (
        <div className="bg-surface px-5 py-4" onDoubleClick={() => setSource(true)}>
          {value.trim() ? <JdDocument markdown={value} /> : <p className="text-[12.5px] text-ink-faint">Nothing written yet.</p>}
        </div>
      )}
    </div>
  );
}
