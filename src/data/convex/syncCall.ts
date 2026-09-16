import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { convexConfig } from "@/lib/convexServer";

/**
 * A Convex mutation, called synchronously.
 *
 * `repo` is synchronous — about ninety write methods and a couple of hundred
 * call sites, many of them composed inside one another — and turning it async
 * was tried and abandoned (see src/data/prime.ts). So a write is committed
 * without returning to the event loop: a worker thread makes the HTTP call and
 * the caller waits on a shared counter until it has an answer.
 *
 * It blocks this server process for the length of one mutation — tens of
 * milliseconds against a local backend. On a recruitment desk that is a
 * handful of saves a minute, and it buys every save a real success or failure
 * that the action can report, instead of a write that completes after the
 * page has already said it worked.
 */

const WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", async ({ url, adminKey, path, args, signal, port }) => {
  let reply;
  try {
    const res = await fetch(url + "/api/mutation", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Convex " + adminKey },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (res.ok && body && body.status === "success") reply = { ok: true, value: body.value };
    else reply = { ok: false, error: (body && body.errorMessage) || ("HTTP " + res.status) };
  } catch (e) {
    reply = { ok: false, error: "Could not reach the Convex backend (" + (e && e.message) + ")" };
  }
  port.postMessage(reply);
  port.close();
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(WORKER, { eval: true });
    // The worker only ever waits for work; it must not keep the process alive.
    worker.unref();
    worker.on("error", () => {
      worker = null;
    });
  }
  return worker;
}

export class SyncCallError extends Error {}

export function convexMutationSync<T>(path: string, args: Record<string, unknown>, timeoutMs = 30_000): T {
  const { url, adminKey } = convexConfig();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  getWorker().postMessage({ url, adminKey, path, args, signal, port: port2 }, [port2]);
  const waited = Atomics.wait(signal, 0, 0, timeoutMs);
  const msg = receiveMessageOnPort(port1)?.message as { ok: boolean; value?: T; error?: string } | undefined;
  port1.close();
  if (waited === "timed-out" || !msg) {
    throw new SyncCallError(`Saving took longer than ${Math.round(timeoutMs / 1000)} seconds and was abandoned; nothing may have been saved.`);
  }
  if (!msg.ok) throw new SyncCallError(msg.error ?? "The save was refused.");
  return msg.value as T;
}
