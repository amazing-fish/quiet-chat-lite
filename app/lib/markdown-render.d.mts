export type MarkdownTextNode = { type: "text"; value: string };
export type MarkdownInlineNode =
  | MarkdownTextNode
  | { type: "strong" | "emphasis" | "strikethrough"; children: MarkdownInlineNode[] }
  | { type: "inlineCode"; value: string }
  | { type: "lineBreak" }
  | {
      type: "link";
      href: string;
      external: boolean;
      title: string | null;
      children: MarkdownInlineNode[];
    };

export type MarkdownHighlightNode =
  | { type: "codeText"; value: string }
  | { type: "highlightSpan"; classes: string[]; children: MarkdownHighlightNode[] };

export type MarkdownTableCell = {
  type: "tableCell";
  align: "left" | "center" | "right" | null;
  children: MarkdownInlineNode[];
};

export type MarkdownListItem = {
  type: "listItem";
  children: MarkdownBlockNode[];
};

export type MarkdownBlockNode =
  | { type: "heading"; depth: number; children: MarkdownInlineNode[] }
  | { type: "paragraph"; children: MarkdownInlineNode[] }
  | { type: "blockquote"; children: MarkdownBlockNode[] }
  | {
      type: "list";
      ordered: boolean;
      start: number | null;
      children: MarkdownListItem[];
    }
  | { type: "table"; header: MarkdownTableCell[]; rows: MarkdownTableCell[][] }
  | {
      type: "codeBlock";
      language: string;
      highlighted: boolean;
      value: string;
      children: MarkdownHighlightNode[];
    }
  | { type: "thematicBreak" };

export type MarkdownDocument = {
  type: "document";
  children: MarkdownBlockNode[];
};

export type SafeLinkTarget = { href: string; external: boolean };

export function safeLinkTarget(href: unknown): SafeLinkTarget | null;
export function markdownToRenderTree(markdown: unknown): MarkdownDocument;
