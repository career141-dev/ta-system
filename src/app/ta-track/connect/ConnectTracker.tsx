"use client";
import { useState } from "react";

export function ConnectTracker({ name, email }: { name: string; email: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function disconnect() {
    if (!confirm("Disconnect every browser tracking with your account?")) return;
    setBusy(true); setMessage("");
    try {
      const res = await fetch('/api/ta-track?action=disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessage('Browser connections disconnected. Uploaded reports remain until their 30-day retention expires.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not disconnect.'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-2xl px-6 py-10"><h1 className="text-2xl font-semibold">Browser tracking</h1><p className="my-4 text-sm text-ink-soft">Signed in as {name} ({email}). Open the tracker extension, enter this email, accept the notice and choose Start tracking. Tracking connects through this signed-in tab with no extra confirmation window.</p><p role="status" className="my-4 text-sm">{message}</p><button disabled={busy} className="text-sm text-danger underline" onClick={() => void disconnect()}>Disconnect all my browsers</button></main>;
}
