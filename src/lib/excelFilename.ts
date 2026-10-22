/** Shared by downloads, email attachments and the email preview. */
export function excelFilename(client: string, position: string, location?: string, date = new Date()): string {
  const clean = (value: string) => value
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/g, "");
  const parts = [clean(client) || "Client", clean(position) || "Position"];
  if (location && clean(location)) parts.push(clean(location));
  return [...parts, date.toISOString().slice(0, 10)].join(" - ") + ".xlsx";
}

export function excelDownloadDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
