import assert from "node:assert/strict";
import test from "node:test";

import {
  createProxyHandler,
  resolvePublicHostname,
  resolveWithDns,
  validateBaseUrl,
} from "../app/lib/proxy.mjs";

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

test("runtime DNS validation accepts A-only public hosts and ignores shim CNAME values", async () => {
  assert.deepEqual(
    await resolveWithDns("gateway.example", {
      resolve4: async () => ["alias.example.", "3.208.46.244"],
      resolve6: async () => { throw new Error("ENODATA"); },
    }),
    ["3.208.46.244"],
  );
});

test("proxy/TUN synthetic DNS answers are revalidated through public DNS", async () => {
  const addresses = await resolvePublicHostname("gateway.example", {
    resolver: {
      resolve4: async () => ["198.18.0.23"],
      resolve6: async () => { throw new Error("ENODATA"); },
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

test("mixed synthetic and ordinary private DNS answers fail closed", async () => {
  let publicDnsCalled = false;
  const resolveHostname = (hostname) => resolvePublicHostname(hostname, {
    resolver: {
      resolve4: async () => ["198.18.0.23", "10.0.0.8"],
      resolve6: async () => { throw new Error("ENODATA"); },
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

test("hexadecimal IPv4-mapped private IPv6 targets remain blocked", async () => {
  for (const address of [
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:c0a8:108",
  ]) {
    await assert.rejects(
      () => validateBaseUrl(`https://[${address}]/v1`, async () => ["8.8.8.8"]),
      (error) => error?.code === "unsafe_target",
    );
  }
});

test("DNS validation timeout stops before the upstream model request", async () => {
  let upstreamCalled = false;
  const handler = createProxyHandler({
    dnsTimeoutMs: 0,
    resolveHostname: async (_hostname, { signal }) => new Promise((_, reject) => {
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
