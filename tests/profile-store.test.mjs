import assert from "node:assert/strict";
import test from "node:test";

import {
  createProfileStore,
  profileSummaryFromRow,
  ProfileConfigurationError,
  ProfileInputError,
} from "../app/lib/profile-store.mjs";

test("profile summaries expose metadata without credential material", () => {
  const summary = profileSummaryFromRow({
    base_url: "https://api.example/v1",
    model: "model-one",
    api_key_ciphertext: "ciphertext-secret",
    api_key_iv: "iv-secret",
  });

  assert.deepEqual(summary, {
    baseUrl: "https://api.example/v1",
    model: "model-one",
    hasApiKey: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /ciphertext-secret|iv-secret|apiKey/);
});

test("profile storage configuration fails closed", () => {
  assert.throws(
    () => createProfileStore({ db: { prepare() {} }, encryptionSecret: "" }),
    ProfileConfigurationError,
  );
});

function createMemoryDb(initialRow = null) {
  let row = initialRow;
  return {
    get row() {
      return row;
    },
    prepare(sql) {
      if (sql.startsWith("CREATE TABLE")) {
        return { run: async () => ({ success: true }) };
      }
      return {
        bind(...values) {
          return {
            first: async () => row,
            run: async () => {
              if (sql.startsWith("INSERT INTO")) {
                row = {
                  base_url: values[1],
                  model: values[2],
                  api_key_ciphertext: values[3],
                  api_key_iv: values[4],
                };
              } else if (sql.startsWith("UPDATE user_profiles")) {
                row = { ...row, base_url: values[0], model: values[1] };
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

test("saved profiles preserve an existing key when a settings update omits it", async () => {
  const db = createMemoryDb();
  const store = createProfileStore({
    db,
    encryptionSecret: "test-encryption-secret",
  });

  await store.saveProfile("person@example.com", {
    baseUrl: "https://api.example/v1",
    model: "model-one",
    apiKey: "sk-server-only",
  });
  const firstCiphertext = db.row.api_key_ciphertext;
  assert.doesNotMatch(JSON.stringify(db.row), /sk-server-only/);

  await store.saveProfile("person@example.com", {
    baseUrl: "https://api.example/v2",
    model: "model-two",
  });

  assert.equal(db.row.api_key_ciphertext, firstCiphertext);
  assert.deepEqual(await store.getCredentials("person@example.com"), {
    baseUrl: "https://api.example/v2",
    model: "model-two",
    apiKey: "sk-server-only",
  });
  assert.deepEqual(await store.getProfileSummary("person@example.com"), {
    baseUrl: "https://api.example/v2",
    model: "model-two",
    hasApiKey: true,
  });
});

test("a first profile save still requires an API key", async () => {
  const store = createProfileStore({
    db: createMemoryDb(),
    encryptionSecret: "test-encryption-secret",
  });
  await assert.rejects(
    () => store.saveProfile("person@example.com", {
      baseUrl: "https://api.example/v1",
      model: "model-one",
    }),
    ProfileInputError,
  );
});
