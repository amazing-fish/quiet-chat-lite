import { lexer } from "marked";
import { common, createLowlight } from "lowlight";

const highlighter = createLowlight(common);
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
const EXTERNAL_SCHEMES = new Set(["http", "https"]);
const SCHEME_WHITESPACE = /[\u0000-\u0020\u007f-\u009f]/g;
const SAFE_HIGHLIGHT_CLASS = /^hljs-[a-z0-9_-]+$/i;

function text(value) {
  return { type: "text", value: typeof value === "string" ? value : "" };
}

function fallbackDocument(markdown) {
  return {
    type: "document",
    children: markdown
      ? [{ type: "paragraph", children: [text(markdown)] }]
      : [],
  };
}

/**
 * Accept only known-safe absolute schemes plus ordinary relative references.
 * Whitespace/control characters are removed only while checking a possible
 * scheme so values such as `java\nscript:` cannot bypass the allowlist.
 */
export function safeLinkTarget(href) {
  if (typeof href !== "string") return null;

  const value = href.trim();
  // Browsers normalize backslashes while resolving URLs. Rejecting every
  // backslash prevents mixed forms such as `/\\evil.example` from becoming a
  // network-path reference after this function classified them as relative.
  if (!value || value.includes("\\")) return null;
  if (value.startsWith("//")) return { href: value, external: true };

  const compact = value.replace(SCHEME_WHITESPACE, "");
  const colonIndex = compact.indexOf(":");
  const pathIndex = compact.search(/[/?#]/);
  const hasScheme = colonIndex > 0 && (pathIndex === -1 || colonIndex < pathIndex);

  if (!hasScheme) return { href: value, external: false };

  const scheme = compact.slice(0, colonIndex).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || !SAFE_SCHEMES.has(scheme)) return null;

  return {
    href: value,
    external: EXTERNAL_SCHEMES.has(scheme),
  };
}

function highlightChildren(children) {
  const result = [];

  for (const child of Array.isArray(children) ? children : []) {
    if (child?.type === "text") {
      result.push({ type: "codeText", value: typeof child.value === "string" ? child.value : "" });
      continue;
    }

    if (child?.type !== "element") continue;

    const nested = highlightChildren(child.children);
    if (child.tagName !== "span") {
      result.push(...nested);
      continue;
    }

    const rawClasses = Array.isArray(child.properties?.className)
      ? child.properties.className
      : typeof child.properties?.className === "string"
        ? child.properties.className.split(/\s+/)
        : [];
    const classes = rawClasses.filter(
      (className) => typeof className === "string" && SAFE_HIGHLIGHT_CLASS.test(className),
    );

    result.push({ type: "highlightSpan", classes, children: nested });
  }

  return result;
}

function codeBlock(token) {
  const value = typeof token.text === "string" ? token.text : "";
  const requestedLanguage = typeof token.lang === "string"
    ? token.lang.trim().split(/\s+/, 1)[0].toLowerCase()
    : "";
  const language = requestedLanguage || "text";

  if (!requestedLanguage || !highlighter.registered(requestedLanguage)) {
    return {
      type: "codeBlock",
      language,
      highlighted: false,
      value,
      children: [{ type: "codeText", value }],
    };
  }

  try {
    const highlighted = highlighter.highlight(requestedLanguage, value);
    return {
      type: "codeBlock",
      language,
      highlighted: true,
      value,
      children: highlightChildren(highlighted.children),
    };
  } catch {
    return {
      type: "codeBlock",
      language,
      highlighted: false,
      value,
      children: [{ type: "codeText", value }],
    };
  }
}

function inlineTokens(tokens) {
  const nodes = [];

  for (const token of Array.isArray(tokens) ? tokens : []) {
    switch (token?.type) {
      case "text":
      case "escape":
        nodes.push(text(token.text));
        break;
      case "strong":
        nodes.push({ type: "strong", children: inlineTokens(token.tokens) });
        break;
      case "em":
        nodes.push({ type: "emphasis", children: inlineTokens(token.tokens) });
        break;
      case "del":
        nodes.push({ type: "strikethrough", children: inlineTokens(token.tokens) });
        break;
      case "codespan":
        nodes.push({ type: "inlineCode", value: typeof token.text === "string" ? token.text : "" });
        break;
      case "br":
        nodes.push({ type: "lineBreak" });
        break;
      case "link": {
        const target = safeLinkTarget(token.href);
        if (!target) {
          nodes.push(text(token.raw));
          break;
        }
        nodes.push({
          type: "link",
          href: target.href,
          external: target.external,
          title: typeof token.title === "string" ? token.title : null,
          children: inlineTokens(token.tokens),
        });
        break;
      }
      case "image":
      case "html":
        nodes.push(text(token.raw));
        break;
      default:
        nodes.push(text(token?.raw ?? token?.text ?? ""));
    }
  }

  return nodes;
}

function tableCell(cell, fallbackAlign = null) {
  const align = ["left", "center", "right"].includes(cell?.align)
    ? cell.align
    : ["left", "center", "right"].includes(fallbackAlign)
      ? fallbackAlign
      : null;
  return {
    type: "tableCell",
    align,
    children: inlineTokens(cell?.tokens),
  };
}

function blockTokens(tokens) {
  const nodes = [];

  for (const token of Array.isArray(tokens) ? tokens : []) {
    switch (token?.type) {
      case "space":
      case "def":
        break;
      case "heading":
        nodes.push({
          type: "heading",
          depth: Math.min(6, Math.max(1, Number(token.depth) || 1)),
          children: inlineTokens(token.tokens),
        });
        break;
      case "paragraph":
        nodes.push({ type: "paragraph", children: inlineTokens(token.tokens) });
        break;
      case "text":
        nodes.push({
          type: "paragraph",
          children: token.tokens ? inlineTokens(token.tokens) : [text(token.text ?? token.raw)],
        });
        break;
      case "blockquote":
        nodes.push({ type: "blockquote", children: blockTokens(token.tokens) });
        break;
      case "list": {
        const items = (Array.isArray(token.items) ? token.items : []).map((item) => ({
          type: "listItem",
          children: blockTokens(item.tokens),
        }));
        if (items.length > 0 && items.every((item) => item.children.length === 0)) {
          nodes.push({ type: "paragraph", children: [text(token.raw)] });
          break;
        }
        nodes.push({
          type: "list",
          ordered: Boolean(token.ordered),
          start: token.ordered && Number.isFinite(Number(token.start)) ? Number(token.start) : null,
          children: items,
        });
        break;
      }
      case "table":
        nodes.push({
          type: "table",
          header: (Array.isArray(token.header) ? token.header : []).map((cell, index) =>
            tableCell(cell, token.align?.[index])),
          rows: (Array.isArray(token.rows) ? token.rows : []).map((row) =>
            (Array.isArray(row) ? row : []).map((cell, index) => tableCell(cell, token.align?.[index]))),
        });
        break;
      case "code":
        nodes.push(codeBlock(token));
        break;
      case "hr":
        nodes.push({ type: "thematicBreak" });
        break;
      case "html":
        nodes.push({ type: "paragraph", children: [text(token.raw)] });
        break;
      default:
        nodes.push({ type: "paragraph", children: [text(token?.raw ?? token?.text ?? "")] });
    }
  }

  return nodes;
}

export function markdownToRenderTree(markdown) {
  const source = typeof markdown === "string" ? markdown : "";

  try {
    return {
      type: "document",
      children: blockTokens(lexer(source, { gfm: true, breaks: false, async: false })),
    };
  } catch {
    return fallbackDocument(source);
  }
}
