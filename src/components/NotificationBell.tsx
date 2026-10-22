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
  href?: string | null;
  read: boolean;
  createdAt: string;
}

/**
 * Shared AudioContext for the application window.
 *
 * Browsers require a user interaction (click, keypress, touch) before Web Audio
 * can output sound. We attach passive window listeners to unlock/resume the shared
 * AudioContext on the user's first interaction so background polls can reliably chime.
 */
let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

if (typeof window !== "undefined") {
  const unlockAudio = () => {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    } catch {}
  };
  window.addEventListener("pointerdown", unlockAudio, { passive: true, capture: true });
  window.addEventListener("keydown", unlockAudio, { passive: true, capture: true });
  window.addEventListener("click", unlockAudio, { passive: true, capture: true });
}

/**
 * Synthesizes a bright, resonant two-tone brass bell chime (G5 -> C6).
 *
 * Designed with a sharp metallic strike transient and physical harmonic overtones
 * that decay naturally, producing the clear acoustic signature of a desk/reception bell.
 */
export async function playNotificationBell() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
    if (ctx.state === "suspended") return;

    const now = ctx.currentTime;

    // Master gain & dynamics compressor to ensure a warm, punchy, distortion-free bell sound
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.42, now);

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-16, now);
    compressor.knee.setValueAtTime(10, now);
    compressor.ratio.setValueAtTime(4, now);
    compressor.attack.setValueAtTime(0.003, now);
    compressor.release.setValueAtTime(0.2, now);

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Two-tone bell chime:
    // Strike 1: G5 (~784 Hz) with bright overtone resonance
    // Strike 2: C6 (~1046.5 Hz) with extended ringing decay
    const strikes = [
      {
        start: now,
        duration: 0.9,
        fundamental: 784,
        partials: [
          { freqMult: 1, gain: 0.35 },
          { freqMult: 2, gain: 0.18 },
          { freqMult: 3, gain: 0.10 },
          { freqMult: 4.2, gain: 0.06 },
        ],
        strikeFreq: 3136,
      },
      {
        start: now + 0.15,
        duration: 1.4,
        fundamental: 1046.5,
        partials: [
          { freqMult: 1, gain: 0.40 },
          { freqMult: 2, gain: 0.22 },
          { freqMult: 3, gain: 0.12 },
          { freqMult: 4.2, gain: 0.07 },
        ],
        strikeFreq: 4186,
      },
    ];

    strikes.forEach(({ start, duration, fundamental, partials, strikeFreq }) => {
      // Metallic strike transient (the click of the bell clapper)
      const strikeOsc = ctx.createOscillator();
      const strikeGain = ctx.createGain();
      strikeOsc.type = "sine";
      strikeOsc.frequency.setValueAtTime(strikeFreq, start);
      strikeGain.gain.setValueAtTime(0.22, start);
      strikeGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.035);
      strikeOsc.connect(strikeGain);
      strikeGain.connect(masterGain);
      strikeOsc.start(start);
      strikeOsc.stop(start + 0.04);

      // Resonant harmonic bell partials
      partials.forEach(({ freqMult, gain: pGain }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(fundamental * freqMult, start);

        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(pGain, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        osc.connect(gain);
        gain.connect(masterGain);

        osc.start(start);
        osc.stop(start + duration + 0.05);
      });
    });
  } catch {
    // Autoplay blocked or no audio output device
  }
}

/** Flashes tab title when a notification arrives while the window is in the background */
function flashNotificationTitle(text: string) {
  if (typeof document === "undefined" || !document.hidden) return;
  const originalTitle = document.title;
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    document.title = ticks % 2 === 1 ? `🔔 ${text}` : originalTitle;
    if (ticks >= 12 || !document.hidden) {
      clearInterval(interval);
      document.title = originalTitle;
    }
  }, 1000);

  const onVisible = () => {
    clearInterval(interval);
    document.title = originalTitle;
    document.removeEventListener("visibilitychange", onVisible);
  };
  document.addEventListener("visibilitychange", onVisible);
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
 * The bell in the header. Polls `/api/notifications` and chimes audibly whenever
 * new notifications arrive (e.g. strategy assignments from the TA Lead).
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

      if (seenIds.current) {
        const newUnread = unread.filter((n) => !seenIds.current!.has(n.id));
        if (newUnread.length > 0) {
          playNotificationBell();
          flashNotificationTitle(newUnread[0].title);
        }
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
    let intervalId: NodeJS.Timeout;

    // 10s polling when page is visible for fast responsive notification; 20s when in background
    const startPolling = () => {
      clearInterval(intervalId);
      const ms = typeof document !== "undefined" && document.hidden ? 20_000 : 10_000;
      intervalId = setInterval(poll, ms);
    };

    startPolling();

    const onVisibilityChange = () => {
      if (!document.hidden) poll();
      startPolling();
    };

    const onFocus = () => {
      poll();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
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
        className="relative grid h-9 w-9 place-items-center rounded-lg text-ink-soft hover:bg-paper hover:text-ink cursor-pointer"
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
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => playNotificationBell()}
                title="Test notification sound"
                aria-label="Test notification sound"
                className="text-[11px] text-ink-faint hover:text-ink cursor-pointer"
              >
                Test sound
              </button>
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-[11.5px] font-medium text-brand hover:underline cursor-pointer">
                  Mark all read
                </button>
              )}
            </div>
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

                const strategyHref = n.type === "strategy_assigned" && n.jobId ? `/openings/${n.jobId}/strategies` : null;
                const linkHref =
                  n.href ??
                  strategyHref ??
                  (n.type.startsWith("workday_")
                    ? "/openings?checks=open"
                    : n.jobId
                    ? `/openings/${n.jobId}`
                    : null);

                return linkHref ? (
                  <Link
                    key={n.id}
                    href={linkHref}
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
