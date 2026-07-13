import assert from "node:assert/strict";
import test from "node:test";

import { randomId } from "../app/lib/id.mjs";

test("IDs remain available when crypto.randomUUID is unavailable", () => {
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    const first = randomId();
    const second = randomId();
    assert.equal(typeof first, "string");
    assert.notEqual(first, second);
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
    });
  }
});
