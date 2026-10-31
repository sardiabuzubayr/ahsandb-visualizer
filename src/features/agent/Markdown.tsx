import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./mdParse";

/** Agent reply text rendered from the Markdown subset in mdParse.ts. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="flex flex-col gap-2 leading-relaxed">{blocks.map(block)}</div>;
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={i} className="m-0 whitespace-pre-wrap">
          {spans(b.c)}
        </p>
      );
    case "h":
      return (
        <p key={i} role="heading" aria-level={b.level} className={b.level <= 2 ? "m-0 mt-1 text-[14px] font-semibold" : "m-0 mt-1 font-semibold"}>
          {spans(b.c)}
        </p>
      );
    case "code":
      return (
        <pre key={i} className="m-0 overflow-x-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] leading-normal">
          <code>{b.v}</code>
        </pre>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={i} start={b.ordered ? b.start : undefined} className={`m-0 flex flex-col gap-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"} marker:text-faint`}>
          {b.items.map((it, j) => (
            <li key={j} className="pl-0.5">
              <span className="whitespace-pre-wrap">{spans(it.c)}</span>
              {it.sub && <div className="mt-1">{block(it.sub, 0)}</div>}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={i} className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-surface text-muted">
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} className="border-b border-border px-2.5 py-1.5 text-left font-medium">
                    {spans(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j} className="border-b border-border last:border-0">
                  {r.map((c, k) => (
                    <td key={k} className="px-2.5 py-1.5 align-top">
                      {spans(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      return (
        <div key={i} className="flex flex-col gap-2 border-l-2 border-border-strong pl-3 text-muted">
          {b.c.map(block)}
        </div>
      );
  }
}

function spans(c: Inline[]): ReactNode {
  return c.map((s, i) => {
    switch (s.t) {
      case "text":
        return <Fragment key={i}>{s.v}</Fragment>;
      case "code":
        return (
          <code key={i} className="rounded bg-raised px-1 py-px font-mono text-[0.88em]">
            {s.v}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold">
            {spans(s.c)}
          </strong>
        );
      case "em":
        return <em key={i}>{spans(s.c)}</em>;
      case "link":
        // shortcut: links aren't clickable (a click would navigate the app's webview); add an opener plugin if agents start citing URLs.
        return (
          <span key={i} title={s.href} className="text-accent underline underline-offset-2">
            {spans(s.c)}
          </span>
        );
    }
  });
}
