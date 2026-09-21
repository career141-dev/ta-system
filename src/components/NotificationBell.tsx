"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BellIcon } from "./icons";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  jobId: string | null;
  read: boolean;
  createdAt: string;
}

const POLL_MS = 20_000;

/**
 * A short two-tone chime, synthesized on the fly rather than shipped as a
 * sound file — nothing to fetch, nothing to license, and it survives a
 * cache-cleared browser the same as a `public/` asset never could.
 *
 * Browsers refuse to start an AudioContext before the page has seen a click,
 * so a chime due before that is simply skipped — the badge still updates.
 */
function playChime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
    setTimeout(() => ctx.close().catch(() => {}), 700);
  } catch {
    // No audio device, or the autoplay policy blocked it either way.
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * The bell in the header. Nothing in this app pushes to the browser, so this
 * polls its own feed (`/api/notifications`) rather than subscribing — the
 * same reason the Alerts badge next to it is recomputed on each page load,
 * just on a timer instead of on navigation.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // null until the first poll lands, so arriving on an already-unread inbox
  // does not itself sound the chime.
  const seenIds = useRef<Set<string> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { signedOut?: boolean; unreadCount: number; notifications: NotificationItem[] };
      // Between session tokens — keep what is shown; the next poll catches up.
      if (data.signedOut) return;
      const unread = data.notifications.filter((n) => !n.read);

      if (seenIds.current && unread.some((n) => !seenIds.current!.has(n.id))) {
        playChime();
      }
      seenIds.current = new Set(unread.map((n) => n.id));

      setItems(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // A missed poll is invisible — the next one catches up.
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const markRead = (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  };

  const markAllRead = () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative grid h-9 w-9 place-items-center rounded-lg text-ink-soft hover:bg-paper hover:text-ink"
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[16px] min-w-[16px] place-items-center rounded-full bg-danger px-1 text-[9.5px] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-rule bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-rule px-3 py-2">
            <span className="text-[12.5px] font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-[11.5px] font-medium text-brand hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto py-1">
            {items.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-ink-faint">Nothing yet.</div>
            ) : (
              items.map((n) => {
                const row = (
                  <div className={`flex flex-col gap-0.5 px-3 py-2 text-left ${n.read ? "" : "bg-paper"} hover:bg-paper`}>
                    <span className="text-[12.5px] font-medium">{n.title}</span>
                    <span className="text-[11.5px] leading-snug text-ink-soft">{n.body}</span>
                    <span className="text-[10.5px] text-ink-faint">{timeAgo(n.createdAt)}</span>
                  </div>
                );
                return n.jobId ? (
                  <Link
                    key={n.id}
                    href={`/openings/${n.jobId}`}
                    onClick={() => {
                      setOpen(false);
                      if (!n.read) markRead(n.id);
                    }}
                    className="block"
                  >
                    {row}
                  </Link>
                ) : (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => !n.read && markRead(n.id)}
                    className="block w-full"
                  >
                    {row}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
