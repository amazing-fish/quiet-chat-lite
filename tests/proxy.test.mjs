import assert from "node:assert/strict";
import test from "node:test";

import {
  createProxyHandler,
  resolvePublicHostname,
  resolveWithDns,
  validateBaseUrl,
} from "../app/lib/proxy.mjs";

const publicResolver = async () => ["8.8.8.8"];

function proxyRequest({ baseUrl = "https://api.example/v1", signal } = {}) {
  return new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl,
      model: "model-one",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
    signal,
  });
}

test("runtime DNS validation accepts an A-only public hostname", async () => {
  const addresses = await resolveWithDns("77code.cn", {
    resolve4: async () => ["77.83.241.109"],
    resolve6: async () => {
      throw new Error("ENODATA");
    },
  });

  assert.deepEqual(addresses, ["77.83.241.109"]);
});

test("runtime DNS validation ignores CNAME values returned by runtime shims", async () => {
  const addresses = await resolveWithDns("tunnel.example", {
    resolve4: async () => ["dd.localhost.run.", "3.208.46.244"],
    resolve6: async () => {
      throw new Error("ENODATA");
    },
  });

  assert.deepEqual(addresses, ["3.208.46.244"]);
});

test("runtime DNS validation falls back between public DNS providers", async () => {
  const queries = [];
  const addresses = await resolvePublicHostname("tunnel.example", {
    resolver: {
      resolve4: async () => ["198.18.0.23"],
      resolve6: async () => {
        throw new Error("ENODATA");
      },
    },
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      queries.push(
        `${requestUrl.hostname}:${requestUrl.searchParams.get("type")}`,
      );
      if (requestUrl.hostname === "cloudflare-dns.com") {
        throw new Error("TLS failure");
      }
      if (requestUrl.searchParams.get("type") === "A") {
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "3.208.46.244" }],
        });
      }
      return Response.json({ Status: 0 });
    },
  });

  assert.deepEqual(queries.sort(), [
    "cloudflare-dns.com:A",
    "cloudflare-dns.com:AAAA",
    "dns.google:A",
    "dns.google:AAAA",
  ]);
  assert.deepEqual(addresses, ["3.208.46.244"]);
});

test("runtime DNS validation falls back when the runtime resolver has no addresses", async () => {
  const addresses = await resolvePublicHostname("tunnel.example", {
    resolver: {
      resolve4: async () => {
        throw new Error("ENODATA");
      },
      resolve6: async () => {
        throw new Error("ENODATA");
      },
    },
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      if (requestUrl.searchParams.get("type") === "A") {
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "3.208.46.244" }],
        });
      }
      return Response.json({ Status: 0 });
    },
  });

  assert.deepEqual(addresses, ["3.208.46.244"]);
});

test("runtime DNS validation rechecks mixed synthetic and public addresses", async () => {
  let publicDnsCalled = false;
  const addresses = await resolvePublicHostname("tunnel.example", {
    resolver: {
      resolve4: async () => ["198.18.0.23"],
      resolve6: async () => ["2606:4700:4700::1111"],
    },
    fetchImpl: async (url) => {
      publicDnsCalled = true;
      const requestUrl = new URL(url);
      if (requestUrl.searchParams.get("type") === "A") {
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "3.208.46.244" }],
        });
      }
      return Response.json({ Status: 0 });
    },
  });

  assert.equal(publicDnsCalled, true);
  assert.deepEqual(addresses, ["3.208.46.244"]);
});

test("runtime DNS validation does not recheck mixed synthetic and private addresses", async () => {
  let publicDnsCalled = false;
  const resolveHostname = (hostname) =>
    resolvePublicHostname(hostname, {
      resolver: {
        resolve4: async () => ["198.18.0.23", "10.0.0.8"],
        resolve6: async () => {
          throw new Error("ENODATA");
        },
      },
      fetchImpl: async () => {
        publicDnsCalled = true;
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "3.208.46.244" }],
        });
      },
    });

  await assert.rejects(
    () => validateBaseUrl("https://private.example/v1", resolveHostname),
    (error) => error?.code === "unsafe_target",
  );
  assert.equal(publicDnsCalled, false);
});

test("public DNS fallback stops waiting for stalled providers and keeps completed answers", async () => {
  const controller = new AbortController();
  let completedQueryCount = 0;
  let markCompletedQueries;
  const completedQueries = new Promise((resolve) => {
    markCompletedQueries = resolve;
  });
  const stalled = new Promise(() => {});
  const addressesPromise = resolvePublicHostname("tunnel.example", {
    resolver: {
      resolve4: async () => ["198.18.0.23"],
      resolve6: async () => {
        throw new Error("ENODATA");
      },
    },
    fetchImpl: async (url, init) => {
      assert.equal(init.signal, controller.signal);
      const requestUrl = new URL(url);
      if (
        requestUrl.hostname === "dns.google" &&
        requestUrl.searchParams.get("type") === "A"
      ) {
        return stalled;
      }
      const payload =
        requestUrl.searchParams.get("type") === "A"
          ? {
              Status: 0,
              Answer: [{ type: 1, data: "3.208.46.244" }],
            }
          : { Status: 0 };
      return {
        ok: true,
        async json() {
          completedQueryCount += 1;
          if (completedQueryCount === 3) markCompletedQueries();
          return payload;
        },
      };
    },
    signal: controller.signal,
  });

  await completedQueries;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  assert.deepEqual(await addressesPromise, ["3.208.46.244"]);
});

test("public DNS fallback fails closed when every provider is aborted", async () => {
  const controller = new AbortController();
  let queryCount = 0;
  let markQueriesStarted;
  const queriesStarted = new Promise((resolve) => {
    markQueriesStarted = resolve;
  });
  const addressesPromise = resolvePublicHostname("tunnel.example", {
    resolver: {
      resolve4: async () => ["198.18.0.23"],
      resolve6: async () => {
        throw new Error("ENODATA");
      },
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      queryCount += 1;
      if (queryCount === 4) markQueriesStarted();
      return new Promise(() => {});
    },
    signal: controller.signal,
  });

  await queriesStarted;
  controller.abort();

  await assert.rejects(addressesPromise, /Public DNS lookup returned no addresses/);
});

test("runtime DNS validation does not bypass ordinary private addresses", async () => {
  let publicDnsCalled = false;
  const resolveHostname = (hostname) =>
    resolvePublicHostname(hostname, {
      resolver: {
        resolve4: async () => ["10.0.0.8"],
        resolve6: async () => {
          throw new Error("ENODATA");
        },
      },
      fetchImpl: async () => {
        publicDnsCalled = true;
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "3.208.46.244" }],
        });
      },
    });

  await assert.rejects(
    () => validateBaseUrl("https://private.example/v1", resolveHostname),
    (error) => error?.code === "unsafe_target",
  );
  assert.equal(publicDnsCalled, false);
});

test("runtime DNS validation rejects private addresses returned by public DNS", async () => {
  const resolveHostname = (hostname) =>
    resolvePublicHostname(hostname, {
      resolver: {
        resolve4: async () => ["198.18.0.23"],
        resolve6: async () => {
          throw new Error("ENODATA");
        },
      },
      fetchImpl: async () =>
        Response.json({
          Status: 0,
          Answer: [{ type: 1, data: "192.168.1.8" }],
        }),
    });

  await assert.rejects(
    () => validateBaseUrl("https://rebound.example/v1", resolveHostname),
    (error) => error?.code === "unsafe_target",
  );
});

test("proxy bounds stalled DNS validation before starting the upstream request", async () => {
  let upstreamCalled = false;
  const handler = createProxyHandler({
    dnsTimeoutMs: 0,
    resolveHostname: async (_hostname, { signal }) =>
      new Promise((_, reject) => {
        const rejectOnAbort = () => reject(signal.reason);
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener("abort", rejectOnAbort, { once: true });
      }),
    fetchImpl: async () => {
      upstreamCalled = true;
      return Response.json({ choices: [{ message: { content: "unexpected" } }] });
    },
  });

  const response = await handler(proxyRequest());
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "dns_validation_failed");
  assert.equal(upstreamCalled, false);
});

test("proxy forwards client cancellation to DNS validation", async () => {
  const requestController = new AbortController();
  let markResolverStarted;
  const resolverStarted = new Promise((resolve) => {
    markResolverStarted = resolve;
  });
  const handler = createProxyHandler({
    dnsTimeoutMs: 30_000,
    resolveHostname: async (_hostname, { signal }) =>
      new Promise((_, reject) => {
        const rejectOnAbort = () => reject(signal.reason);
        signal.addEventListener("abort", rejectOnAbort, { once: true });
        markResolverStarted();
      }),
  });
  const responsePromise = handler(
    proxyRequest({ signal: requestController.signal }),
  );

  await resolverStarted;
  requestController.abort();
  const response = await responsePromise;
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "dns_validation_failed");
});

test("proxy rejects non-HTTPS, local, private, credentialed, and internally-resolved targets", async () => {
  const rejected = [
    "http://api.example/v1",
    "file:///tmp/model",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://172.16.2.3/v1",
    "https://192.168.1.8/v1",
    "https://169.254.169.254/latest",
    "https://[::1]/v1",
    "https://[fc00::1]/v1",
    "https://user:pass@api.example/v1",
    "https://service.internal/v1",
  ];

  for (const target of rejected) {
    await assert.rejects(() => validateBaseUrl(target, publicResolver));
  }

  await assert.rejects(() =>
    validateBaseUrl("https://rebind.example/v1", async () => ["10.1.2.3"]),
  );
});

test("proxy rejects hexadecimal IPv4-mapped private IPv6 targets", async () => {
  const mappedPrivateAddresses = [
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:108",
  ];

  for (const address of mappedPrivateAddresses) {
    await assert.rejects(
      () => validateBaseUrl(`https://[${address}]/v1`, publicResolver),
      (error) => error?.code === "unsafe_target",
    );
    await assert.rejects(
      () => validateBaseUrl("https://mapped.example/v1", async () => [address]),
      (error) => error?.code === "unsafe_target",
    );
  }

  const publicMapped = await validateBaseUrl(
    "https://[::ffff:8.8.8.8]/v1",
    publicResolver,
  );
  assert.equal(
    publicMapped.href,
    "https://[::ffff:808:808]/v1/chat/completions",
  );
});

test("proxy appends the chat completions path and forwards only the supported request shape", async () => {
  let upstream;
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async (url, init) => {
      upstream = { url: String(url), init, body: JSON.parse(init.body) };
      return Response.json({ choices: [{ message: { content: "你好" } }] });
    },
  });

  const response = await handler(
    new Request("https://site.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.example/v1",
        model: "model-next",
        apiKey: "secret",
        messages: [
          { role: "user", content: "第一问" },
          { role: "assistant", content: "第一答" },
          { role: "user", content: "第二问" },
        ],
        ignored: "not-forwarded",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstream.url, "https://api.example/v1/chat/completions");
  assert.equal(upstream.init.headers.authorization, "Bearer secret");
  assert.deepEqual(upstream.body, {
    model: "model-next",
    messages: [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ],
    stream: false,
  });
  const responseBody = await response.json();
  assert.equal(responseBody.content, "你好");
  assert.equal(responseBody.upstreamResponse.status, 200);
  assert.equal(
    responseBody.upstreamResponse.body,
    JSON.stringify({ choices: [{ message: { content: "你好" } }] }),
  );
});

test("proxy maps a bare public origin to the standard v1 endpoint", async () => {
  let upstreamUrl;
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async (url) => {
      upstreamUrl = String(url);
      return Response.json({ choices: [{ message: { content: "你好" } }] });
    },
  });

  const response = await handler(
    new Request("https://site.example/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://77code.cn",
        model: "grok-4.5",
        apiKey: "secret",
        messages: [{ role: "user", content: "测试" }],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamUrl, "https://77code.cn/v1/chat/completions");
});

test("proxy maps authentication, network, timeout, invalid response, and tool calls", async (t) => {
  const cases = [
    {
      name: "authentication",
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      status: 401,
      code: "upstream_auth",
    },
    {
      name: "network",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      status: 502,
      code: "upstream_network",
    },
    {
      name: "timeout",
      fetchImpl: async () => {
        throw new DOMException("aborted", "AbortError");
      },
      status: 504,
      code: "upstream_timeout",
    },
    {
      name: "invalid response",
      fetchImpl: async () => Response.json({ result: "unexpected" }),
      status: 502,
      code: "invalid_upstream_response",
    },
    {
      name: "tool calls",
      fetchImpl: async () =>
        Response.json({ choices: [{ message: { tool_calls: [{ id: "call-1" }] } }] }),
      status: 422,
      code: "tool_calls_unsupported",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const handler = createProxyHandler({
        resolveHostname: publicResolver,
        fetchImpl: item.fetchImpl,
      });
      const response = await handler(
        new Request("https://site.example/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseUrl: "https://api.example/v1",
            model: "model-one",
            apiKey: "secret",
            messages: [{ role: "user", content: "测试" }],
          }),
        }),
      );

      assert.equal(response.status, item.status);
      const responseBody = await response.json();
      assert.equal(responseBody.error.code, item.code);
      if (item.name !== "network" && item.name !== "timeout") {
        assert.equal(typeof responseBody.upstreamResponse.body, "string");
      }
    });
  }
});

test("proxy preserves the exact upstream error body for diagnostics", async () => {
  const rawBody = '{"error":{"message":"model not found"},"request_id":"req-raw-1"}\n';
  const handler = createProxyHandler({
    resolveHostname: publicResolver,
    fetchImpl: async () => new Response(rawBody, {
      status: 404,
      statusText: "Not Found",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-raw-1",
        "set-cookie": "session=must-not-leak",
      },
    }),
  });

  const response = await handler(new Request("https://site.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: "https://api.example/v1",
      model: "missing-model",
      apiKey: "secret",
      messages: [{ role: "user", content: "测试" }],
    }),
  }));
  const responseBody = await response.json();

  assert.equal(responseBody.upstreamResponse.status, 404);
  assert.equal(responseBody.upstreamResponse.statusText, "Not Found");
  assert.equal(responseBody.upstreamResponse.body, rawBody);
  assert.equal(responseBody.upstreamResponse.headers["x-request-id"], "req-raw-1");
  assert.equal(responseBody.upstreamResponse.headers["set-cookie"], undefined);
  assert.doesNotMatch(JSON.stringify(responseBody), /must-not-leak/);
});
