"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  markdownToRenderTree,
  type MarkdownBlockNode,
  type MarkdownHighlightNode,
  type MarkdownInlineNode,
  type MarkdownListItem,
} from "./lib/markdown-render.mjs";

function renderInline(node: MarkdownInlineNode, key: string): ReactNode {
  switch (node.type) {
    case "text":
      return <Fragment key={key}>{node.value}</Fragment>;
    case "strong":
      return <strong key={key}>{node.children.map((child, index) => renderInline(child, `${key}-${index}`))}</strong>;
    case "emphasis":
      return <em key={key}>{node.children.map((child, index) => renderInline(child, `${key}-${index}`))}</em>;
    case "strikethrough":
      return <del key={key}>{node.children.map((child, index) => renderInline(child, `${key}-${index}`))}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "lineBreak":
      return <br key={key} />;
    case "link":
      return (
        <a
          key={key}
          href={node.href}
          title={node.title ?? undefined}
          target={node.external ? "_blank" : undefined}
          rel={node.external ? "noopener noreferrer" : undefined}
        >
          {node.children.map((child, index) => renderInline(child, `${key}-${index}`))}
        </a>
      );
  }
}

function renderHighlight(node: MarkdownHighlightNode, key: string): ReactNode {
  if (node.type === "codeText") return <Fragment key={key}>{node.value}</Fragment>;
  return (
    <span key={key} className={node.classes.join(" ") || undefined}>
      {node.children.map((child, index) => renderHighlight(child, `${key}-${index}`))}
    </span>
  );
}

function CodeBlock({ node }: { node: Extract<MarkdownBlockNode, { type: "codeBlock" }> }) {
  const [copyResult, setCopyResult] = useState<{
    value: string;
    state: "copied" | "error";
  } | null>(null);
  const copyState = copyResult?.value === node.value ? copyResult.state : "idle";

  const copy = async () => {
    const valueToCopy = node.value;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(valueToCopy);
      setCopyResult({ value: valueToCopy, state: "copied" });
    } catch {
      setCopyResult({ value: valueToCopy, state: "error" });
    }
  };

  return (
    <section className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{node.language}</span>
        <button type="button" onClick={copy} aria-label={`复制 ${node.language} 代码`}>
          {copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre tabIndex={0}><code>{node.children.map((child, index) => renderHighlight(child, `code-${index}`))}</code></pre>
    </section>
  );
}

function renderListItem(item: MarkdownListItem, key: string) {
  return <li key={key}>{item.children.map((child, index) => renderBlock(child, `${key}-${index}`))}</li>;
}

function renderHeading(node: Extract<MarkdownBlockNode, { type: "heading" }>, key: string) {
  const children = node.children.map((child, index) => renderInline(child, `${key}-${index}`));
  switch (node.depth) {
    case 1: return <h1 key={key}>{children}</h1>;
    case 2: return <h2 key={key}>{children}</h2>;
    case 3: return <h3 key={key}>{children}</h3>;
    case 4: return <h4 key={key}>{children}</h4>;
    case 5: return <h5 key={key}>{children}</h5>;
    default: return <h6 key={key}>{children}</h6>;
  }
}

function renderBlock(node: MarkdownBlockNode, key: string): ReactNode {
  switch (node.type) {
    case "heading":
      return renderHeading(node, key);
    case "paragraph":
      return <p key={key}>{node.children.map((child, index) => renderInline(child, `${key}-${index}`))}</p>;
    case "blockquote":
      return <blockquote key={key}>{node.children.map((child, index) => renderBlock(child, `${key}-${index}`))}</blockquote>;
    case "list": {
      const items = node.children.map((item, index) => renderListItem(item, `${key}-${index}`));
      return node.ordered
        ? <ol key={key} start={node.start ?? undefined}>{items}</ol>
        : <ul key={key}>{items}</ul>;
    }
    case "table":
      return (
        <div className="markdown-table-scroll" key={key} tabIndex={0}>
          <table>
            <thead>
              <tr>{node.header.map((cell, index) => (
                <th key={`${key}-h-${index}`} style={cell.align ? { textAlign: cell.align } : undefined}>
                  {cell.children.map((child, childIndex) => renderInline(child, `${key}-h-${index}-${childIndex}`))}
                </th>
              ))}</tr>
            </thead>
            <tbody>{node.rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>{row.map((cell, cellIndex) => (
                <td key={`${key}-r-${rowIndex}-${cellIndex}`} style={cell.align ? { textAlign: cell.align } : undefined}>
                  {cell.children.map((child, childIndex) => renderInline(child, `${key}-r-${rowIndex}-${cellIndex}-${childIndex}`))}
                </td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>
      );
    case "codeBlock":
      return <CodeBlock key={key} node={node} />;
    case "thematicBreak":
      return <hr key={key} />;
  }
}

export function MarkdownMessage({ markdown }: { markdown: string }) {
  const tree = useMemo(() => markdownToRenderTree(markdown), [markdown]);
  return <div className="markdown-message">{tree.children.map((node, index) => renderBlock(node, `block-${index}`))}</div>;
}
