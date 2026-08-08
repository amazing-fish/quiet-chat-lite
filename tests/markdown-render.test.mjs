import assert from "node:assert/strict";
import test from "node:test";

import { markdownToRenderTree, safeLinkTarget } from "../app/lib/markdown-render.mjs";

function descendants(value) {
  const result = [];
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    result.push(current);
    for (const child of Object.values(current)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return result;
}

function nodesOfType(tree, type) {
  return descendants(tree).filter((node) => node.type === type);
}

function visibleText(node) {
  if (!node || typeof node !== "object") return "";
  if (["text", "inlineCode", "codeText"].includes(node.type)) return node.value;
  if (node.type === "codeBlock") return node.value;

  const parts = [];
  for (const [key, child] of Object.entries(node)) {
    if (["value", "href", "title", "language", "classes", "align", "type"].includes(key)) continue;
    if (Array.isArray(child)) parts.push(child.map(visibleText).join("\n"));
    else if (child && typeof child === "object") parts.push(visibleText(child));
  }
  return parts.filter(Boolean).join("\n");
}

test("converts the required Markdown and GFM syntax to a render structure", () => {
  const markdown = [
    "# Heading",
    "",
    "Paragraph with **bold**, *italic*, [external](https://example.com/docs), [internal](/help), and `inline code`.",
    "",
    "- first bullet",
    "- second bullet",
    "",
    "3. third item",
    "4. fourth item",
    "",
    "> quoted text",
    "",
    "| Name | Value |",
    "| :--- | ---: |",
    "| safe | 42 |",
    "",
    "```js",
    "const answer = 42;",
    "```",
  ].join("\n");

  const tree = markdownToRenderTree(markdown);
  assert.equal(tree.type, "document");
  assert.equal(nodesOfType(tree, "heading")[0].depth, 1);
  assert.equal(nodesOfType(tree, "strong").length, 1);
  assert.equal(nodesOfType(tree, "emphasis").length, 1);
  assert.equal(nodesOfType(tree, "inlineCode")[0].value, "inline code");

  const lists = nodesOfType(tree, "list");
  assert.equal(lists.find((list) => !list.ordered).children.length, 2);
  assert.equal(lists.find((list) => list.ordered).start, 3);
  assert.equal(nodesOfType(tree, "blockquote").length, 1);

  const table = nodesOfType(tree, "table")[0];
  assert.equal(table.header.length, 2);
  assert.equal(table.header[0].align, "left");
  assert.equal(table.header[1].align, "right");
  assert.equal(table.rows.length, 1);

  const links = nodesOfType(tree, "link");
  assert.deepEqual(
    links.map(({ href, external }) => ({ href, external })),
    [
      { href: "https://example.com/docs", external: true },
      { href: "/help", external: false },
    ],
  );

  const code = nodesOfType(tree, "codeBlock")[0];
  assert.equal(code.language, "js");
  assert.equal(code.highlighted, true);
  assert.equal(code.value, "const answer = 42;");
  assert.ok(nodesOfType(code, "highlightSpan").length > 0);
  assert.match(visibleText(tree), /Heading/);
  assert.match(visibleText(tree), /quoted text/);
});

test("treats raw HTML and images as text and rejects executable URL schemes", () => {
  const markdown = [
    "<script>alert('xss')</script>",
    "",
    "<img src=x onerror=alert(1)>",
    "",
    "[script](javascript:alert(1))",
    "[data](data:text/html,<script>alert(1)</script>)",
    "[vb](vbscript:msgbox(1))",
    "![fake image](data:text/html,<script>alert(1)</script>)",
    "[safe](https://example.com)",
  ].join("\n");

  const tree = markdownToRenderTree(markdown);
  const allNodes = descendants(tree);
  const links = nodesOfType(tree, "link");

  assert.deepEqual(links.map((link) => link.href), ["https://example.com"]);
  assert.equal(allNodes.some((node) => ["html", "script", "image", "img"].includes(node.type)), false);
  assert.equal(allNodes.some((node) => Object.keys(node).some((key) => /^on/i.test(key))), false);
  assert.equal(allNodes.some((node) => "src" in node || "dangerouslySetInnerHTML" in node), false);
  assert.match(visibleText(tree), /<script>/);
  assert.match(visibleText(tree), /onerror=/);
  assert.match(visibleText(tree), /data:text\/html/);
});

test("uses an allowlist for links including obfuscated dangerous schemes", () => {
  const controlObfuscatedNetworkPath = "/\t/evil.example/path";
  assert.equal(
    new URL("/\\evil.example/path", "https://quiet-chat.example").href,
    "https://evil.example/path",
  );
  assert.equal(
    new URL(controlObfuscatedNetworkPath, "https://quiet-chat.example").href,
    "https://evil.example/path",
  );

  for (const href of [
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "\\\\evil.example/path",
    "/\\evil.example/path",
    "\\/evil.example/path",
    "nested\\path",
  ]) {
    assert.equal(safeLinkTarget(href), null, href);
  }

  assert.deepEqual(safeLinkTarget("https://example.com"), { href: "https://example.com", external: true });
  assert.deepEqual(safeLinkTarget("mailto:hello@example.com"), { href: "mailto:hello@example.com", external: false });
  assert.deepEqual(safeLinkTarget("/local/path"), { href: "/local/path", external: false });
  assert.deepEqual(safeLinkTarget("#section"), { href: "#section", external: false });
  assert.deepEqual(safeLinkTarget("//cdn.example.com/file"), { href: "//cdn.example.com/file", external: true });
  assert.deepEqual(safeLinkTarget(controlObfuscatedNetworkPath), {
    href: controlObfuscatedNetworkPath,
    external: true,
  });
});

test("treats scheme-bearing HTTP URLs as external without a deployment base", () => {
  const cases = [
    {
      href: "https:evil.example",
      base: "http://app.example/page",
      resolvedHref: "https://evil.example/",
    },
    {
      href: "http:evil.example",
      base: "https://app.example/page",
      resolvedHref: "http://evil.example/",
    },
    {
      href: "https:/evil.example",
      base: "http://app.example/page",
      resolvedHref: "https://evil.example/",
    },
    {
      href: "HTTPS:evil.example",
      base: "http://app.example/page",
      resolvedHref: "https://evil.example/",
    },
    {
      href: "https:\tevil.example",
      base: "http://app.example/page",
      resolvedHref: "https://evil.example/",
    },
    {
      href: "https:evil.example/path?a=1",
      base: "http://app.example/page",
      resolvedHref: "https://evil.example/path?a=1",
    },
    {
      href: "https:example.com/path",
      base: "http://app.example/page",
      resolvedHref: "https://example.com/path",
    },
    {
      href: "https:/example.com/path",
      base: "http://app.example/page",
      resolvedHref: "https://example.com/path",
    },
  ];

  for (const { href, base, resolvedHref } of cases) {
    assert.equal(new URL(href, base).href, resolvedHref, `browser navigation: ${JSON.stringify(href)}`);
    assert.deepEqual(safeLinkTarget(href), { href, external: true }, href);
  }

  assert.deepEqual(safeLinkTarget("  https:evil.example  "), {
    href: "https:evil.example",
    external: true,
  });
});

test("uses a compact ASCII-control view only to classify link targets", () => {
  for (const href of ["/\t/evil.example/path", "/\n/evil.example/path", "/\r/evil.example/path"]) {
    assert.equal(
      new URL(href, "https://app.example/page").href,
      "https://evil.example/path",
      `browser navigation: ${JSON.stringify(href)}`,
    );
    assert.deepEqual(safeLinkTarget(href), { href, external: true }, href);
  }

  const dangerous = "\u0001javascript:alert(1)";
  assert.equal(new URL(dangerous).protocol, "javascript:");
  assert.equal(safeLinkTarget(dangerous), null);
});

test("keeps Unicode whitespace and dot-segment paths relative", () => {
  const cases = [
    {
      href: "/\u2028/evil.example/path",
      resolvedHref: "https://app.example/%E2%80%A8/evil.example/path",
    },
    {
      href: "/\u3000/evil.example/path",
      resolvedHref: "https://app.example/%E3%80%80/evil.example/path",
    },
    {
      href: "/docs/../admin",
      resolvedHref: "https://app.example/admin",
    },
  ];

  for (const { href, resolvedHref } of cases) {
    assert.equal(
      new URL(href, "https://app.example/page").href,
      resolvedHref,
      `browser navigation: ${JSON.stringify(href)}`,
    );
    assert.deepEqual(safeLinkTarget(href), { href, external: false }, href);
  }
});

test("pins single-argument URL handling for empty and minimal HTTP targets", () => {
  for (const href of ["https:", "http:"]) {
    assert.throws(() => new URL(href), { name: "TypeError" });
    assert.deepEqual(safeLinkTarget(href), { href, external: false });
  }

  const minimalHost = new URL("https:.");
  assert.equal(minimalHost.host, ".");
  assert.deepEqual(safeLinkTarget("https:."), { href: "https:.", external: true });
});

test("rejects rather than rewrites backslash link targets", () => {
  const cases = [
    {
      href: "/\\evil.example",
      resolvedHref: "https://evil.example/",
    },
    {
      href: "/\\\\evil.example/path",
      resolvedHref: "https://evil.example/path",
    },
    {
      href: "https:\\\\evil.example/path",
      resolvedHref: "https://evil.example/path",
    },
    {
      href: "folder\\..\\secret",
      resolvedHref: "https://app.example/secret",
    },
  ];

  for (const { href, resolvedHref } of cases) {
    assert.equal(
      new URL(href, "https://app.example/page").href,
      resolvedHref,
      `browser normalization: ${JSON.stringify(href)}`,
    );
    assert.equal(safeLinkTarget(href), null, href);
  }
});

test("renders every streaming prefix without throwing or losing received content", () => {
  const chunks = [
    "# Stream title\n\n",
    "Intro with ",
    "**bold",
    " words**",
    "\n\n- first item",
    "\n- second item",
    "\n\n```js\n",
    "const answer = ",
    "42;\n",
    "```",
    "\n\nTail _done_.",
  ];
  const durableFragments = ["Stream title", "Intro with", "bold", "words", "first item", "second item", "const answer", "42", "Tail", "done"];
  let prefix = "";

  for (const chunk of chunks) {
    prefix += chunk;
    let tree;
    assert.doesNotThrow(() => { tree = markdownToRenderTree(prefix); });
    const rendered = visibleText(tree);
    for (const fragment of durableFragments) {
      if (prefix.includes(fragment)) assert.ok(rendered.includes(fragment), `${fragment} missing from ${prefix}`);
    }
  }
});

test("incomplete fences, lists, and emphasis markers degrade to readable text", () => {
  const cases = [
    { markdown: "```ts\nconst partial = true;", expected: "const partial = true;" },
    { markdown: "- item still streaming", expected: "item still streaming" },
    { markdown: "-", expected: "-" },
    { markdown: "*", expected: "*" },
    { markdown: "single *", expected: "single *" },
    { markdown: "single _", expected: "single _" },
  ];

  for (const { markdown, expected } of cases) {
    let tree;
    assert.doesNotThrow(() => { tree = markdownToRenderTree(markdown); });
    assert.ok(visibleText(tree).includes(expected), markdown);
  }

  const incompleteFence = markdownToRenderTree("```ts\nconst partial = true;");
  assert.equal(nodesOfType(incompleteFence, "codeBlock")[0].language, "ts");
});

test("unknown fenced languages remain readable without invoking an unsafe renderer", () => {
  const tree = markdownToRenderTree("```made-up-language\n<a onclick=alert(1)>\n```");
  const code = nodesOfType(tree, "codeBlock")[0];
  assert.equal(code.language, "made-up-language");
  assert.equal(code.highlighted, false);
  assert.equal(code.value, "<a onclick=alert(1)>");
  assert.deepEqual(code.children, [{ type: "codeText", value: "<a onclick=alert(1)>" }]);
});
