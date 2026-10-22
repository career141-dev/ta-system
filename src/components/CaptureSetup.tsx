import { extensionToken } from "@/lib/extension";
import { CopyToken } from "./CopyToken";

/**
 * Where the browser extension gets its key.
 *
 * It sits on Excel Tables because that is where the captures land — the TA who
 * needs the token is already looking at the table it fills.
 */
export function CaptureSetup() {
  return (
    <details className="mb-5 rounded-xl border border-rule bg-surface px-6 py-4">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[13px] font-medium">
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" className="text-brand">
          <path
            d="M8 1.5l5.5 2.4v3.6c0 3.2-2.2 5.6-5.5 7-3.3-1.4-5.5-3.8-5.5-7V3.9L8 1.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M5.6 7.9l1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Capture from LinkedIn
        <span className="font-normal text-[12px] text-ink-faint">
          — file the profile you are looking at straight into this table
        </span>
      </summary>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-5 border-t border-rule pt-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-[12.5px] leading-relaxed text-ink-soft">
          <li>
            In Chrome, open <code className="rounded bg-paper px-1.5 py-0.5 text-[11.5px]">chrome://extensions</code>{" "}
            and turn on Developer mode.
          </li>
          <li>
            <strong className="font-medium text-ink">Load unpacked</strong>, and choose the{" "}
            <code className="rounded bg-paper px-1.5 py-0.5 text-[11.5px]">extension</code> folder in the project.
          </li>
          <li>Click the extension, open the ⚙, and paste the key opposite.</li>
          <li>Choose who you are, the opening, and its work location. For location capture, reload the extension using version 0.3.0 or later.</li>
        </ol>

        <div>
          <span className="mb-1.5 block text-[12px] text-ink-soft">Access key</span>
          <CopyToken token={extensionToken()} />
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
            It reads the profile you have open, when you press the button. It never opens a profile
            on its own, and every capture records whose press it was.
          </p>
        </div>
      </div>
    </details>
  );
}
