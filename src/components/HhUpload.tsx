"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "./Submit";

/**
 * "Upload headhunted CV" on TA Follow-up (28 Sep).
 *
 * Each file goes to /api/hh/upload, which queues it on the CV platform's own
 * extraction for this opening. The panel then asks where each one has got to
 * until it is in TA Follow-up, flagged HH, and refreshes the list below.
 */
const MAX_FILES = 10;

type Row = {
  key: string;
  fileName: string;
  id: string | null;
  state: "uploading" | "reading" | "done" | "held" | "failed" | "missing";
  name: string | null;
  note: string | null;
  createdAt?: number;
  stage?: string;
  label?: string;
  progress?: number;
  elapsedMs?: number;
  estimateSeconds?: number | null;
};

const LINE: Record<Row["state"], string> = {
  uploading: "Uploading…",
  reading: "Reading the CV…",
  done: "Added to TA Follow-up (HH)",
  held: "Not added",
  failed: "Could not be read",
  missing: "Not found",
};

const shortTime = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export function HhUpload({ openingId, workLocationId }: { openingId: string; workLocationId?: string }) {
  const queueKey = `hh-upload-queue:${openingId}${workLocationId ? `:${workLocationId}` : ""}`;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const seenDone = useRef(new Set<string>());
  const loadedFromStorageRef = useRef(false);

  // Restore queued uploads from localStorage on mount and recover interrupted state
  useEffect(() => {
    if (loadedFromStorageRef.current) return;
    loadedFromStorageRef.current = true;
    try {
      const raw = localStorage.getItem(queueKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const valid = parsed
        .filter((r): r is Row => Boolean(r && typeof r === "object" && r.key && r.fileName))
        .filter((r) => !r.createdAt || r.createdAt > oneDayAgo)
        .map((r) => {
          if (r.state === "uploading" && !r.id) {
            return {
              ...r,
              state: "failed" as const,
              note: "Upload was interrupted before reaching the server. Please upload again.",
            };
          }
          return r;
        });

      if (valid.length > 0) {
        setRows(valid);
        const hasActive = valid.some((r) => r.state === "uploading" || r.state === "reading");
        if (hasActive) setOpen(true);
        valid.forEach((r) => {
          if ((r.state === "done" || r.state === "held") && r.id) {
            seenDone.current.add(r.id);
          }
        });
      }
    } catch {
      // Ignore storage errors
    }
  }, [openingId, queueKey]);

  // Keep queue synced to localStorage and notify listeners
  useEffect(() => {
    if (!loadedFromStorageRef.current) return;
    try {
      if (rows.length > 0) {
        localStorage.setItem(queueKey, JSON.stringify(rows));
      } else {
        localStorage.removeItem(queueKey);
      }
      window.dispatchEvent(new CustomEvent("hh-upload-sync", { detail: { openingId } }));
    } catch {
      // Ignore storage errors
    }
  }, [rows, openingId, queueKey]);

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const clearFinished = () => {
    setRows((rs) => rs.filter((r) => r.state === "uploading" || r.state === "reading"));
  };

  async function send(files: File[]) {
    setProblem(null);
    const picked = files.slice(0, MAX_FILES);
    if (files.length > MAX_FILES) setProblem(`Up to ${MAX_FILES} CVs at a time — the first ${MAX_FILES} are being added.`);
    const fresh: Row[] = picked.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      fileName: f.name,
      id: null,
      state: "uploading",
      name: null,
      note: null,
      createdAt: Date.now(),
    }));
    setRows((rs) => [...fresh, ...rs]);
    // Three transfers at a time: enough to avoid serial upload delay without
    // flooding the app server with ten multi-megabyte request bodies.
    let next = 0;
    const uploadNext = async () => {
      while (next < picked.length) {
        const i = next++;
        const body = new FormData();
        body.set("openingId", openingId);
        if (workLocationId) body.set("workLocationId", workLocationId);
        body.set("file", picked[i]);
        try {
          const res = await fetch("/api/hh/upload", { method: "POST", body });
          const json = (await res.json()) as { ok: boolean; id?: string; message?: string };
          if (json.ok && json.id) patch(fresh[i].key, { id: json.id, state: "reading", stage: "queued", label: "Waiting for a CV reader", progress: 8 });
          else patch(fresh[i].key, { state: "failed", note: json.message ?? "The upload failed." });
        } catch {
          patch(fresh[i].key, { state: "failed", note: "The upload did not reach the server. Try again." });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, picked.length) }, uploadNext));
  }

  // Ask where the queued files are while any is still being read.
  const waiting = rows.filter((r) => r.state === "reading" && r.id).map((r) => r.id!);
  const waitingKey = waiting.join(",");
  useEffect(() => {
    if (!waitingKey) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/hh/upload?openingId=${encodeURIComponent(openingId)}&ids=${encodeURIComponent(waitingKey)}`);
        const json = (await res.json()) as { ok: boolean; files?: (Pick<Row, "state" | "name" | "note" | "stage" | "label" | "progress" | "elapsedMs" | "estimateSeconds"> & { id: string })[] };
        if (stop || !json.ok || !json.files) return;
        let landed = false;
        setRows((rs) =>
          rs.map((r) => {
            const f = json.files!.find((x) => x.id === r.id);
            if (!f) return r;
            if ((f.state === "done" || f.state === "held") && !seenDone.current.has(f.id)) {
              seenDone.current.add(f.id);
              landed = true;
            }
            return { ...r, ...f, name: f.name ?? r.name };
          }),
        );
        if (landed) router.refresh();
      } catch {
        /* the next tick asks again */
      }
    };
    const timer = setInterval(tick, 4000);
    tick();
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [waitingKey, openingId, router]);

  const activeCount = rows.filter((r) => r.state === "uploading" || r.state === "reading").length;

  return (
    <div className="mb-6">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-full border border-brand-line px-4 py-1.5 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
        >
          {activeCount > 0 && <Spinner tone="dark" />}
          <span>Upload headhunted CV</span>
          {activeCount > 0 && <span className="ml-1 text-[11px] font-normal text-ink-soft">({activeCount} processing…)</span>}
        </button>
      ) : (
        <div className="rounded-xl border border-rule bg-surface p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[13.5px] font-medium">Upload headhunted CVs</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                Each CV is read for all its details, checked against the database, and added here in TA Follow-up
                under your name, flagged HH. PDF or Word, up to 10 MB, {MAX_FILES} at a time.
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-soft hover:text-ink cursor-pointer">
              Close
            </button>
          </div>

          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) send(files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const files = Array.from(e.dataTransfer.files ?? []);
              if (files.length) send(files);
            }}
            className={`mt-3 flex w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 py-7 text-[12.5px] transition-colors ${
              dragging ? "border-brand bg-brand-soft text-brand" : "border-rule text-ink-soft hover:border-brand/40 hover:text-brand"
            }`}
          >
            <span className="font-medium">Choose CVs</span>
            <span className="mt-0.5 text-[11.5px] text-ink-faint">or drop them here</span>
          </button>

          {problem && <p className="mt-3 text-[12px] text-warn">{problem}</p>}

          {rows.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-ink">Uploads & extractions</span>
                {rows.some((r) => r.state !== "uploading" && r.state !== "reading") && (
                  <button
                    type="button"
                    onClick={clearFinished}
                    className="text-[11.5px] text-ink-faint hover:text-ink cursor-pointer"
                  >
                    Clear finished
                  </button>
                )}
              </div>
              <ul className="divide-y divide-rule rounded-lg border border-rule">
                {rows.map((r) => (
                  <li key={r.key} className="flex items-center justify-between gap-4 px-3 py-2 text-[12.5px]">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{r.name ?? r.fileName}</div>
                      {r.name && <div className="truncate text-[11.5px] text-ink-faint">{r.fileName}</div>}
                      {r.note && <div className="text-[11.5px] text-ink-soft">{r.note}</div>}
                      {r.state === "reading" && typeof r.progress === "number" && (
                        <>
                          <div className="mt-1.5 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-rule">
                            <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${r.progress}%` }} />
                          </div>
                          {typeof r.elapsedMs === "number" && (
                            <div className="mt-1 text-[10.5px] text-ink-faint">
                              {shortTime(r.elapsedMs)} elapsed{r.estimateSeconds ? ` · this step can take about ${shortTime(r.estimateSeconds * 1000)}` : ""}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1.5 ${
                        r.state === "done" ? "text-brand" : r.state === "failed" || r.state === "held" || r.state === "missing" ? "text-danger" : "text-ink-soft"
                      }`}
                    >
                      {(r.state === "uploading" || r.state === "reading") && <Spinner tone="dark" />}
                      {r.state === "reading" ? (r.label ?? LINE.reading) : LINE[r.state]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
