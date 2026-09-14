"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CARD, drawSnippet, type Box, type Boxes } from "@/lib/snippetDraw";
import {
  BLOCK_ORDER,
  LEVEL_BY_KEY,
  type BlockKey,
  type SnippetFields,
  type SnippetLayout,
} from "@/lib/snippet";

/** Where the design puts things — dragging near one of these snaps to it, so a
 *  nudge that was meant to tidy an overflow does not quietly break the grid. */
const GUIDES_X = [90.3, 117.1, 539, 540, 657];
const GUIDES_Y = [37.4, 241.3, 357.5, 435.2, 567, 641.5, 731.4, 1026];
const SNAP = 7;

function snap(value: number, guides: number[]) {
  const hit = guides.find((g) => Math.abs(g - value) < SNAP);
  return hit ?? Math.round(value);
}

type Drag =
  | { mode: "move"; key: BlockKey; startX: number; startY: number; ox: number; oy: number }
  | { mode: "resize"; key: BlockKey; startX: number; ow: number };

/**
 * The card, and the handles on it.
 *
 * The picture is a canvas because the canvas is also the export — anything
 * drawn twice, once for the screen and once for the file, drifts. The handles
 * are DOM on top of it, positioned from the boxes the painter reports, so
 * selection sits exactly on the ink.
 */
export function SnippetStage({
  fields,
  layout,
  selected,
  onSelect,
  onChange,
  onCanvas,
  reference,
}: {
  fields: SnippetFields;
  layout: SnippetLayout;
  selected: BlockKey | null;
  onSelect: (k: BlockKey | null) => void;
  onChange: (k: BlockKey, patch: { x?: number; y?: number; w?: number }) => void;
  onCanvas: (c: HTMLCanvasElement | null) => void;
  reference?: string;
}) {
  const [refOn, setRefOn] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [boxes, setBoxes] = useState<Boxes | null>(null);
  const [plate, setPlate] = useState<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);

  const plateSrc = LEVEL_BY_KEY[fields.level]?.plate;

  useEffect(() => {
    if (!plateSrc) return;
    let live = true;
    const img = new Image();
    img.src = plateSrc;
    img.onload = () => live && setPlate(img);
    return () => {
      live = false;
    };
  }, [plateSrc]);

  // Canvas takes the font from the document, so a repaint before the webfont
  // arrives measures the fallback and wraps to the wrong place.
  useEffect(() => {
    let live = true;
    document.fonts.ready.then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);

  const paint = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    setBoxes(drawSnippet(ctx, fields, layout, plate));
  }, [fields, layout, plate]);

  useEffect(() => {
    paint();
  }, [paint, ready]);

  const toCard = (clientDelta: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return clientDelta;
    return (clientDelta / rect.width) * CARD;
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === "move") {
        onChange(d.key, {
          x: snap(d.ox + toCard(e.clientX - d.startX), GUIDES_X),
          y: snap(d.oy + toCard(e.clientY - d.startY), GUIDES_Y),
        });
      } else {
        onChange(d.key, { w: Math.max(60, Math.round(d.ow + toCard(e.clientX - d.startX))) });
      }
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [onChange]);

  const pct = (n: number) => `${(n / CARD) * 100}%`;

  return (
    <div
      ref={wrapRef}
      className="relative w-full select-none overflow-hidden rounded-xl border border-rule bg-tag"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || e.target === canvasRef.current) onSelect(null);
      }}
    >
      <canvas
        ref={(c) => {
          canvasRef.current = c;
          onCanvas(c);
        }}
        width={CARD}
        height={CARD}
        className="block w-full"
      />

      {/* The design, laid straight over the render. Nothing but a check. */}
      {reference && (
        <>
          {refOn && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={reference}
              alt=""
              className="pointer-events-none absolute inset-0 h-full w-full mix-blend-difference"
            />
          )}
          <button
            onClick={() => setRefOn((v) => !v)}
            className="absolute right-2 top-2 z-10 rounded-full bg-black/70 px-3 py-1.5 text-[11px] font-medium text-white"
          >
            {refOn ? "Hide Canva" : "Show Canva"}
          </button>
        </>
      )}

      {boxes &&
        BLOCK_ORDER.map((key) => {
          const b: Box = boxes[key];
          const isSel = selected === key;
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              aria-label={key}
              onPointerDown={(e) => {
                e.preventDefault();
                onSelect(key);
                dragRef.current = {
                  mode: "move",
                  key,
                  startX: e.clientX,
                  startY: e.clientY,
                  ox: layout[key].x,
                  oy: layout[key].y,
                };
              }}
              className={`absolute cursor-move rounded-[3px] transition-colors ${
                isSel
                  ? "outline outline-2 outline-[#2f6df6]"
                  : "outline outline-1 outline-transparent hover:outline-[#2f6df6]/45"
              }`}
              style={{ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) }}
            >
              {isSel && (
                <>
                  <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-[#2f6df6] px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {Math.round(layout[key].x)}, {Math.round(layout[key].y)}
                  </span>
                  <span
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      dragRef.current = {
                        mode: "resize",
                        key,
                        startX: e.clientX,
                        ow: layout[key].w,
                      };
                    }}
                    className="absolute -right-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-[#2f6df6] bg-white"
                  />
                </>
              )}
            </div>
          );
        })}
    </div>
  );
}
