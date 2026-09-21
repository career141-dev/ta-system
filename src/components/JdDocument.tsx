import { Fragment, type ReactNode } from "react";

/**
 * A JD as a document, not as its source.
 *
 * JDs are stored as Markdown, and every screen printed that source — testers
 * read "## Senior software engineer", "**Client**" and "_None recorded._"
 * literally (21 Sep). This draws the handful of forms a JD uses: headings,
 * bold and italic, bullet and numbered lists, and "**Label** value" fact
 * lines. It builds React elements only, never HTML, so nothing in a JD can
 * inject markup.
 */
export function JdDocument({ markdown, className = "" }: { markdown: string; className?: string }) {
  return <div className={`text-[13.5px] leading-[1.75] text-ink ${className}`}>{blocks(markdown)}</div>;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "fact"; label: string; value: string }
  | { kind: "p"; lines: string[] };

function parse(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", lines: para });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      out.push({ kind: "h", level: h[1].length, text: h[2] });
      continue;
    }
    const ul = line.match(/^[-*•]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.items.push((ul ?? ol)![1]);
      else out.push({ kind, items: [(ul ?? ol)![1]] });
      continue;
    }
    // "**Client** Gajani 2nd company" — the fact lines at the top of a JD.
    const fact = line.match(/^\*\*([^*]{1,40})\*\*:?\s+(.+)$/);
    if (fact) {
      flush();
      out.push({ kind: "fact", label: fact[1].replace(/:$/, ""), value: fact[2] });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

function blocks(md: string): ReactNode {
  const parsed = parse(md);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const b = parsed[i];
    if (b.kind === "h") {
      const cls =
        b.level <= 2
          ? "mb-3 mt-1 text-[18px] font-semibold tracking-tight"
          : "mb-2 mt-5 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-soft";
      nodes.push(
        b.level <= 2 ? (
          <h2 key={i} className={cls}>{inline(b.text)}</h2>
        ) : (
          <h3 key={i} className={cls}>{inline(b.text)}</h3>
        ),
      );
    } else if (b.kind === "fact") {
      // Consecutive fact lines form one definition list.
      const facts = [b];
      while (parsed[i + 1]?.kind === "fact") facts.push(parsed[++i] as Extract<Block, { kind: "fact" }>);
      nodes.push(
        <dl key={i} className="mb-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1">
          {facts.map((f, j) => (
            <Fragment key={j}>
              <dt className="text-ink-faint">{f.label}</dt>
              <dd>{inline(f.value)}</dd>
            </Fragment>
          ))}
        </dl>,
      );
    } else if (b.kind === "ul" || b.kind === "ol") {
      const List = b.kind === "ul" ? "ul" : "ol";
      nodes.push(
        <List key={i} className={`mb-3 flex flex-col gap-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"} marker:text-ink-faint`}>
          {b.items.map((item, j) => (
            <li key={j}>{inline(item)}</li>
          ))}
        </List>,
      );
    } else if (b.kind === "p") {
      nodes.push(
        <p key={i} className="mb-3">
          {b.lines.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(l)}
            </Fragment>
          ))}
        </p>,
      );
    }
  }
  return nodes;
}

/** **bold**, __bold__, *italic*, _italic_ — nothing else is interpreted. */
function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  // An underscore only counts at a word edge, so "snake_case_names" stay text.
  const re = /(\*\*|__)(.+?)\1|\*(?=\S)(.+?)(?<=\S)\*|(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      m[2] !== undefined ? <strong key={k++} className="font-semibold">{m[2]}</strong> : <em key={k++}>{m[3] ?? m[4]}</em>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
