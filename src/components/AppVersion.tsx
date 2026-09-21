/**
 * Which release is running — the commit the image was built from.
 *
 * Set at build time (Dockerfile `APP_VERSION`, passed by the release pipeline),
 * so "is my change live yet?" is answered by looking, not by asking (21
 * September). A local build says "dev".
 */
export function AppVersion({ className = "" }: { className?: string }) {
  const v = (process.env.NEXT_PUBLIC_APP_VERSION ?? "dev").slice(0, 7);
  return <span className={`tabular text-[11px] text-ink-faint ${className}`}>Version {v}</span>;
}
