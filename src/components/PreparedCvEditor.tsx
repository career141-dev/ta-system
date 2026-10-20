"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { savePreparedCvBoxInline } from "@/app/actions";
import { ActionNote, Spinner, useInline } from "./Submit";
import { BOX } from "@/lib/career141Box";
import { clampBox, clampBoxWidth, layoutBox, roughMeasure } from "@/lib/preparedCv";
import { browserPdfJs } from "@/lib/pdfBrowser";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

/**
 * The Prepared CV tab (29 Sep): page 1 of the candidate's own CV with the
 * CAREER141 box on it, where the TA drags the box to the spot they want.
 *
 * The page is drawn in the browser (pdfjs-dist); the box is laid over it at the
 * exact position, size and wrapped lines the server stamps — the layout comes
 * from `/api/prepared-cv/<id>?layout=1`, so the box on screen is the box that
 * prints. Dropping it saves the spot; the download and the end-of-day
 * attachment use it.
 */

type Line = { text: string; bold: boolean };
type Layout = {
  box: { x: number; y: number; width: number; height: number; lines: Line[]; items: string[] } | null;
  page: { width: number; height: number };
  generated: boolean;
};

type EditorBox = { x: number; y: number; width: number };
type Drag =
  | { mode: "move"; dx: number; dy: number }
  | { mode: "resize"; startClientX: number; startWidth: number };

export function PreparedCvEditor({
  appId,
  openingId,
  pdfSrc,
  canEdit,
  queryOverrides,
}: {
  appId: string;
  openingId: string;
  /** The candidate's own CV as a PDF (a Word CV converted) — what is stamped. */
  pdfSrc: string | null;
  canEdit: boolean;
  queryOverrides?: string;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [at, setAt] = useState<EditorBox | null>(null);
  const [scale, setScale] = useState(1);
  const [version, setVersion] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [width, setWidth] = useState(0);
  const [previewProblem, setPreviewProblem] = useState(false);
  const numPages = pdfDoc?.numPages ?? 1;
  const frame = useRef<HTMLDivElement | null>(null);
  const canvasMap = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const drag = useRef<Drag | null>(null);
  const reloadAfterSave = useRef(false);
  const afterSave = useCallback(() => {
    if (!reloadAfterSave.current) return;
    reloadAfterSave.current = false;
    setVersion((v) => v + 1);
  }, []);
  const saveOptions = useMemo(() => ({ refreshOnOk: false, onOk: afterSave }), [afterSave]);
  const save = useInline(savePreparedCvBoxInline, saveOptions);

  const load = useCallback(async (signal: AbortSignal) => {
    setProblem(null);
    try {
      const q = queryOverrides ? `&${queryOverrides}` : "";
      const res = await fetch(`/api/prepared-cv/${encodeURIComponent(appId)}?layout=1${q}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(String(res.status));
      const l = (await res.json()) as Layout;
      if (signal.aborted) return;
      setLayout(l);
      setAt(l.box ? { x: l.box.x, y: l.box.y, width: l.box.width } : null);
    } catch {
      if (!signal.aborted) setProblem("The Prepared CV could not be loaded. Reload the page to try again.");
    }
  }, [appId, queryOverrides]);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load, version]);

  // Loading must not depend on the page count: discovering page 2 used to
  // cancel page 1's render and load the same document again (12 Oct).
  useEffect(() => {
    setPdfDoc(null);
    setDrawn(false);
    setPreviewProblem(false);
    if (!layout || layout.generated || !pdfSrc) return;
    let cancelled = false;
    const abort = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | null = null;

    (async () => {
      try {
        const pdfjs = await browserPdfJs();
        const res = await fetch(pdfSrc, { credentials: "same-origin", signal: abort.signal });
        if (!res.ok) throw new Error(`CV request failed (${res.status})`);
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
        const doc = await loadingTask.promise;
        if (!cancelled) setPdfDoc(doc);
      } catch {
        if (!cancelled) setPreviewProblem(true);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      void loadingTask?.destroy().catch(() => {});
    };
  }, [layout, pdfSrc]);

  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [layout, previewProblem]);

  // Render after React has mounted every page's canvas, and again on resize.
  useEffect(() => {
    if (!pdfDoc || width <= 0 || previewProblem) return;
    let cancelled = false;
    const tasks: { cancel(): void }[] = [];
    setDrawn(false);

    (async () => {
      try {
        // Render each page
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          if (cancelled) break;
          const page = await pdfDoc.getPage(p);
          if (cancelled || !frame.current) break;
          const base = page.getViewport({ scale: 1 });
          const s = Math.min(1.6, width / base.width);
          const ratio = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: s * ratio });

          const c = canvasMap.current.get(p);
          if (!c || cancelled) continue;

          c.width = Math.floor(viewport.width);
          c.height = Math.floor(viewport.height);
          c.style.width = `${Math.floor(viewport.width / ratio)}px`;
          c.style.height = `${Math.floor(viewport.height / ratio)}px`;
          const renderTask = page.render({ canvas: c, viewport });
          tasks.push(renderTask);
          await renderTask.promise;
          if (p === 1 && !cancelled) {
            setScale(s);
            setDrawn(true);
          }
        }
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") {
          setPreviewProblem(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      tasks.forEach((t) => {
        try {
          t.cancel();
        } catch {}
      });
    };
  }, [pdfDoc, width, previewProblem]);

  const box = layout?.box ?? null;
  const page = layout?.page ?? { width: 595, height: 842 };
  const shown = useMemo(() => {
    if (!box || !at || at.width === box.width) return box;
    const reflowed = layoutBox(box.items, roughMeasure, at.width);
    return { ...box, width: reflowed.width, height: reflowed.height, lines: reflowed.lines };
  }, [at, box]);

  /** Keep the live preview on the page, in PDF points. */
  const clamp = (x: number, y: number, width = shown?.width ?? 0, height = shown?.height ?? 0) =>
    clampBox({ x, y }, { width, height }, page);

  const submit = (next: EditorBox, reflow: boolean) => {
    reloadAfterSave.current = reflow;
    const fd = new FormData();
    fd.set("appId", appId);
    fd.set("openingId", openingId);
    fd.set("x", String(next.x));
    fd.set("y", String(next.y));
    fd.set("width", String(next.width));
    save.run(fd);
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canEdit || !at) return;
    const page1 = canvasMap.current.get(1);
    if (!page1) return;
    const rect = page1.getBoundingClientRect();
    drag.current = { mode: "move", dx: (e.clientX - rect.left) / scale - at.x, dy: (e.clientY - rect.top) / scale - at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || !at || !box) return;
    const page1 = canvasMap.current.get(1);
    if (!page1) return;
    if (active.mode === "move") {
      const rect = page1.getBoundingClientRect();
      setAt({ ...at, ...clamp((e.clientX - rect.left) / scale - active.dx, (e.clientY - rect.top) / scale - active.dy) });
      return;
    }
    const width = clampBoxWidth(active.startWidth + (e.clientX - active.startClientX) / scale, page.width - at.x + 10);
    const reflowed = layoutBox(box.items, roughMeasure, width);
    setAt({ ...at, width, ...clamp(at.x, at.y, width, reflowed.height) });
  };
  const onUp = () => {
    if (!drag.current || !at) return;
    const resized = drag.current.mode === "resize";
    drag.current = null;
    submit(at, resized);
  };
  // Arrow keys move it too, 5 points a press — for a keyboard, or a fine nudge.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canEdit || !at) return;
    const step = e.shiftKey ? 20 : 5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const next = { ...at, ...clamp(at.x + d[0], at.y + d[1]) };
    setAt(next);
    submit(next, false);
  };
  const onResizeDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!canEdit || !at) return;
    e.stopPropagation();
    drag.current = { mode: "resize", startClientX: e.clientX, startWidth: at.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!canEdit || !at || !box || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    e.stopPropagation();
    const amount = e.shiftKey ? 40 : 10;
    const width = clampBoxWidth(at.width + (e.key === "ArrowRight" ? amount : -amount), page.width - at.x + 10);
    const reflowed = layoutBox(box.items, roughMeasure, width);
    const next = { ...at, width, ...clamp(at.x, at.y, width, reflowed.height) };
    setAt(next);
    submit(next, true);
  };
  const reset = () => {
    const fd = new FormData();
    fd.set("appId", appId);
    fd.set("openingId", openingId);
    fd.set("reset", "1");
    save.run(fd);
    // The automatic spot is worked out on the server; ask for it once saved.
    setTimeout(() => setVersion((v) => v + 1), 800);
  };

  const href = `/api/prepared-cv/${encodeURIComponent(appId)}${queryOverrides ? `?${queryOverrides}` : ""}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[70ch] text-[12.5px] text-ink-soft">
          {canEdit
            ? "Drag the green box to move it. Drag its right handle to change the width; the height adjusts to keep every detail readable."
            : "The CV as the Director and the client receive it."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {save.pending && <Spinner tone="dark" />}
          <ActionNote result={save.result} />
          {canEdit && box && drawn && !previewProblem && (
            <button type="button" onClick={reset} className="rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-ink-soft hover:bg-paper">
              Reset position and size
            </button>
          )}
          <a href={href} target="_blank" rel="noreferrer" className="rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-brand hover:bg-tag">
            Open
          </a>
          <a href={`${href}?download=1`} className="rounded-full bg-brand px-3.5 py-1.5 text-[12px] font-medium text-white">
            Download prepared CV
          </a>
        </div>
      </div>

      {problem && <p className="mb-3 text-[12.5px] text-danger">{problem}</p>}

      {!layout ? (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-faint">
          <Spinner tone="dark" /> Preparing the CV…
        </p>
      ) : previewProblem ? (
        <>
          <p className="mb-2 text-[12.5px] text-ink-soft">
            Showing the Prepared CV in the browser viewer. Box movement is unavailable in this view.
          </p>
          <button type="button" onClick={() => setVersion((v) => v + 1)} className="mb-3 rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-brand hover:bg-tag">
            Retry box editor
          </button>
          <iframe src={href} title="Prepared CV" className="h-[80vh] w-full rounded-lg border border-rule" />
        </>
      ) : layout.generated || !pdfSrc ? (
        <>
          <p className="mb-2 text-[12.5px] text-ink-faint">
            There is no PDF or Word CV on file to place the box on, so this is the CV generated from their details.
          </p>
          <iframe src={href} title="Prepared CV" className="h-[80vh] w-full rounded-lg border border-rule" />
        </>
      ) : (
        <>
          {!drawn && <p className="mb-2 flex items-center gap-2 text-[12.5px] text-ink-faint"><Spinner tone="dark" /> Loading CV pages…</p>}
          {!box && (
            <p className="mb-2 text-[12.5px] text-ink-faint">
              Nothing is recorded for the box yet. Fill in the details for Director review and it appears here.
            </p>
          )}
          <div ref={frame} className="flex flex-col gap-6 w-full max-w-[960px]">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
              <div key={p} className="relative overflow-hidden rounded-lg border border-rule bg-white shadow-xs">
                {numPages > 1 && (
                  <div className="flex items-center justify-between border-b border-rule/60 bg-paper/60 px-3 py-1 text-[11px] text-ink-faint">
                    <span>Page {p} of {numPages}</span>
                    {p === 1 && canEdit && box && <span className="text-brand font-medium">Box placement page</span>}
                  </div>
                )}
                <div className="relative mx-auto w-fit">
                  <canvas
                    ref={(el) => {
                      if (el) canvasMap.current.set(p, el);
                      else canvasMap.current.delete(p);
                    }}
                    className="block mx-auto"
                  />
                  {p === 1 && shown && at && drawn && (
                    <div
                      role={canEdit ? "button" : undefined}
                      tabIndex={canEdit ? 0 : undefined}
                      aria-label={canEdit ? "CAREER141 box — drag, or use the arrow keys, to move it" : undefined}
                      onPointerDown={onDown}
                      onPointerMove={onMove}
                      onPointerUp={onUp}
                      onKeyDown={onKey}
                      className={`absolute select-none touch-none ${canEdit ? "cursor-move focus:outline focus:outline-2 focus:outline-brand" : ""}`}
                      style={{
                        left: at.x * scale,
                        top: at.y * scale,
                        width: shown.width * scale,
                        height: shown.height * scale,
                        padding: BOX.padding * scale,
                        paddingTop: (BOX.padding + 1) * scale,
                        background: "#fff",
                        border: `${BOX.border * scale}px solid ${BOX.green}`,
                        color: BOX.green,
                        fontFamily: "Helvetica, Arial, sans-serif",
                      }}
                    >
                      {shown.lines.map((l, i) => (
                        <div
                          key={i}
                          style={{
                            fontWeight: l.bold ? 700 : 400,
                            fontSize: (l.bold ? BOX.headerSize : BOX.bodySize) * scale,
                            lineHeight: `${BOX.lineHeight * scale}px`,
                            whiteSpace: "pre",
                          }}
                        >
                          {l.text}
                        </div>
                      ))}
                      {canEdit && (
                        <button
                          type="button"
                          aria-label="Resize CAREER141 box width"
                          title="Drag left or right to resize · arrow keys resize precisely"
                          onPointerDown={onResizeDown}
                          onKeyDown={onResizeKey}
                          className="absolute -right-2 top-1/2 h-5 w-3 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-brand bg-white shadow-sm focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-brand"
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
