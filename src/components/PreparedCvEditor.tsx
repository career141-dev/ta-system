"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { savePreparedCvBoxInline } from "@/app/actions";
import { ActionNote, Spinner, useInline } from "./Submit";
import { BOX } from "@/lib/career141Box";

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
  box: { x: number; y: number; width: number; height: number; lines: Line[] } | null;
  page: { width: number; height: number };
  generated: boolean;
};

export function PreparedCvEditor({
  appId,
  openingId,
  pdfSrc,
  canEdit,
}: {
  appId: string;
  openingId: string;
  /** The candidate's own CV as a PDF (a Word CV converted) — what is stamped. */
  pdfSrc: string | null;
  canEdit: boolean;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [version, setVersion] = useState(0);
  const [numPages, setNumPages] = useState(1);
  const frame = useRef<HTMLDivElement | null>(null);
  const canvasMap = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const save = useInline(savePreparedCvBoxInline, { refreshOnOk: false });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/prepared-cv/${encodeURIComponent(appId)}?layout=1`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const l = (await res.json()) as Layout;
      setLayout(l);
      setAt(l.box ? { x: l.box.x, y: l.box.y } : null);
    } catch {
      setProblem("The Prepared CV could not be loaded. Reload the page to try again.");
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // All pages of the CV, drawn to fit the frame's width.
  useEffect(() => {
    if (!layout || layout.generated || !pdfSrc || !frame.current) return;
    let cancelled = false;
    const tasks: { cancel(): void }[] = [];

    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        let doc: any = null;
        try {
          const res = await fetch(pdfSrc, { credentials: "same-origin" });
          if (res.ok) {
            const buffer = await res.arrayBuffer();
            if (!cancelled) {
              doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
            }
          }
        } catch {}
        if (!doc && !cancelled) {
          doc = await pdfjs.getDocument({ url: pdfSrc, withCredentials: true }).promise;
        }
        if (cancelled || !doc) return;
        if (doc.numPages !== numPages) {
          setNumPages(doc.numPages);
        }

        // Render each page
        for (let p = 1; p <= doc.numPages; p++) {
          if (cancelled) break;
          const page = await doc.getPage(p);
          if (cancelled || !frame.current) break;
          const base = page.getViewport({ scale: 1 });
          const s = Math.min(1.6, frame.current.clientWidth / base.width);
          const ratio = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: s * ratio });

          let c = canvasMap.current.get(p);
          if (!c) {
            await new Promise((r) => setTimeout(r, 30));
            c = canvasMap.current.get(p);
          }
          if (!c || cancelled) continue;

          c.width = Math.floor(viewport.width);
          c.height = Math.floor(viewport.height);
          c.style.width = `${Math.floor(viewport.width / ratio)}px`;
          c.style.height = `${Math.floor(viewport.height / ratio)}px`;
          const renderTask = page.render({ canvas: c, viewport });
          tasks.push(renderTask);
          await renderTask.promise;
          if (p === 1 && !cancelled) setScale(s);
        }
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") {
          setProblem("The CV pages could not be drawn here. Open the Prepared CV to see it.");
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
  }, [layout, pdfSrc, numPages]);

  const box = layout?.box ?? null;
  const page = layout?.page ?? { width: 595, height: 842 };

  /** Keep the box on the page, in points. */
  const clamp = (x: number, y: number) => ({
    x: Math.round(Math.min(Math.max(10, x), Math.max(10, page.width - (box?.width ?? 0) - 10))),
    y: Math.round(Math.min(Math.max(10, y), Math.max(10, page.height - (box?.height ?? 0) - 10))),
  });

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canEdit || !at) return;
    const page1 = canvasMap.current.get(1);
    if (!page1) return;
    const rect = page1.getBoundingClientRect();
    drag.current = { dx: (e.clientX - rect.left) / scale - at.x, dy: (e.clientY - rect.top) / scale - at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const page1 = canvasMap.current.get(1);
    if (!page1) return;
    const rect = page1.getBoundingClientRect();
    setAt(clamp((e.clientX - rect.left) / scale - drag.current.dx, (e.clientY - rect.top) / scale - drag.current.dy));
  };
  const onUp = () => {
    if (!drag.current || !at) return;
    drag.current = null;
    const fd = new FormData();
    fd.set("appId", appId);
    fd.set("openingId", openingId);
    fd.set("x", String(at.x));
    fd.set("y", String(at.y));
    save.run(fd);
  };
  // Arrow keys move it too, 5 points a press — for a keyboard, or a fine nudge.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canEdit || !at) return;
    const step = e.shiftKey ? 20 : 5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const next = clamp(at.x + d[0], at.y + d[1]);
    setAt(next);
    const fd = new FormData();
    fd.set("appId", appId);
    fd.set("openingId", openingId);
    fd.set("x", String(next.x));
    fd.set("y", String(next.y));
    save.run(fd);
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

  const href = `/api/prepared-cv/${encodeURIComponent(appId)}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[70ch] text-[12.5px] text-ink-soft">
          {canEdit
            ? "Drag the green box to where it should sit on the CV. The download and the end-of-day email use this spot."
            : "The CV as the Director and the client receive it."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {save.pending && <Spinner tone="dark" />}
          <ActionNote result={save.result} />
          {canEdit && box && (
            <button type="button" onClick={reset} className="rounded-full border border-rule px-3.5 py-1.5 text-[12px] text-ink-soft hover:bg-paper">
              Reset position
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
      ) : layout.generated || !pdfSrc ? (
        <>
          <p className="mb-2 text-[12.5px] text-ink-faint">
            There is no PDF or Word CV on file to place the box on, so this is the CV generated from their details.
          </p>
          <iframe src={href} title="Prepared CV" className="h-[80vh] w-full rounded-lg border border-rule" />
        </>
      ) : (
        <>
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
                <div className="relative">
                  <canvas
                    ref={(el) => {
                      if (el) canvasMap.current.set(p, el);
                      else canvasMap.current.delete(p);
                    }}
                    className="block mx-auto"
                  />
                  {p === 1 && box && at && (
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
                        width: box.width * scale,
                        height: box.height * scale,
                        padding: BOX.padding * scale,
                        paddingTop: (BOX.padding + 1) * scale,
                        background: "#fff",
                        border: `${BOX.border * scale}px solid ${BOX.green}`,
                        color: BOX.green,
                        fontFamily: "Helvetica, Arial, sans-serif",
                      }}
                    >
                      {box.lines.map((l, i) => (
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
