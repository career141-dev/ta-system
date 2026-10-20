import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { unstable_rethrow } from "next/navigation";
import { safeErrorMessage } from "./userError";

/**
 * A server action's answer, for forms that show it beside the button.
 *
 * Every action on the desk says what happened through `back()` — a redirect
 * that puts `?msg=` at the top of the page. On a long form that message lands
 * off-screen, so a save looked like it had done nothing (testing, 21 Sep:
 * Save job details, Save notes, Add to an opening in the database drawer).
 *
 * Rather than fork each action, `inline()` runs the same action with a flag
 * set: `back()` and `done()` then throw their message here instead of
 * redirecting, and it comes back to the form as data. Called from an ordinary
 * `<form action>`, nothing changes.
 */
export type ActionResult = {
  ok: boolean;
  message: string;
  /** "warn" is a save that happened with a caveat — added, but not moved. */
  tone: "ok" | "warn" | "error";
  /** When it answered, so a form with two buttons shows the latest. */
  at: number;
};


const inlineMode = new AsyncLocalStorage<true>();

/** Thrown by back()/done() while an inline action runs; never escapes inline(). */
class InlineAnswer extends Error {
  constructor(
    readonly answer: Omit<ActionResult, "at">,
  ) {
    super(answer.message);
  }
}

export function isInline(): boolean {
  return inlineMode.getStore() === true;
}

/** Stop an inline action with this answer. */
export function answer(message: string, tone: ActionResult["tone"]): never {
  throw new InlineAnswer({ ok: tone !== "error", message, tone });
}

/**
 * Run an action and return what it said. A plain `redirect()` (to a page that
 * was just created, say) still navigates — only the messages are caught.
 */
export async function inline(run: () => Promise<unknown>, fallback = "Saved."): Promise<ActionResult> {
  try {
    await inlineMode.run(true, run);
    return { ok: true, message: fallback, tone: "ok", at: Date.now() };
  } catch (e) {
    if (e instanceof InlineAnswer) return { ...e.answer, at: Date.now() };
    // Next's own redirects and not-founds carry on as navigation.
    unstable_rethrow(e);
    // Anything else would have been the error page; beside the button it is
    // a sentence, and whatever was typed is still in the form.
    const message = safeErrorMessage(e, "That change could not be saved. Try again.");
    return { ok: false, message, tone: "error", at: Date.now() };
  }
}
