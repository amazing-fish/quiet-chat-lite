const PROFILE_SCHEMA = `CREATE TABLE IF NOT EXISTS user_profiles (user_email TEXT PRIMARY KEY, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, api_key_iv TEXT NOT NULL, updated_at TEXT NOT NULL)`;

export class ProfileConfigurationError extends Error {}
export class ProfileInputError extends Error {}

function requireEncryptionSecret(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProfileConfigurationError("PROFILE_ENCRYPTION_KEY is not configured.");
  }
  return value;
}

function bytesToBase64(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveEncryptionKey(secret, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requireEncryptionSecret(secret)),
  );
  return cryptoImpl.subtle.importKey(
    "raw",
    digest,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export function profileSummaryFromRow(row) {
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    model: row.model,
    hasApiKey: Boolean(row.api_key_ciphertext && row.api_key_iv),
  };
}

export function createProfileStore({
  db,
  encryptionSecret,
  cryptoImpl = globalThis.crypto,
}) {
  requireEncryptionSecret(encryptionSecret);
  if (!db || typeof db.prepare !== "function") {
    throw new ProfileConfigurationError("The profile database is not configured.");
  }

  let schemaReady;
  let keyPromise;
  const encryptionKey = () => {
    keyPromise ??= deriveEncryptionKey(encryptionSecret, cryptoImpl);
    return keyPromise;
  };
  const ensureSchema = () => {
    schemaReady ??= db.prepare(PROFILE_SCHEMA).run();
    return schemaReady;
  };

  async function readRow(email) {
    await ensureSchema();
    return db
      .prepare(
        "SELECT base_url,model,api_key_ciphertext,api_key_iv FROM user_profiles WHERE user_email=?",
      )
      .bind(email)
      .first();
  }

  async function encrypt(value) {
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(),
      new TextEncoder().encode(value),
    );
    return {
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      iv: bytesToBase64(iv),
    };
  }

  async function decrypt(ciphertext, iv) {
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv) },
      await encryptionKey(),
      base64ToBytes(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  }

  return {
    async getProfileSummary(email) {
      return profileSummaryFromRow(await readRow(email));
    },

    async getCredentials(email) {
      const row = await readRow(email);
      if (!row?.api_key_ciphertext || !row?.api_key_iv) return null;
      return {
        baseUrl: row.base_url,
        model: row.model,
        apiKey: await decrypt(row.api_key_ciphertext, row.api_key_iv),
      };
    },

    async saveProfile(email, input) {
      const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
      const model = typeof input?.model === "string" ? input.model.trim() : "";
      const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
      if (!baseUrl || !model) {
        throw new ProfileInputError("请填写 Base URL 和 Model。");
      }

      await ensureSchema();
      if (apiKey) {
        const encrypted = await encrypt(apiKey);
        await db
          .prepare(
            "INSERT INTO user_profiles(user_email,base_url,model,api_key_ciphertext,api_key_iv,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_email) DO UPDATE SET base_url=excluded.base_url,model=excluded.model,api_key_ciphertext=excluded.api_key_ciphertext,api_key_iv=excluded.api_key_iv,updated_at=excluded.updated_at",
          )
          .bind(
            email,
            baseUrl,
            model,
            encrypted.ciphertext,
            encrypted.iv,
            new Date().toISOString(),
          )
          .run();
      } else {
        const existing = await readRow(email);
        if (!existing?.api_key_ciphertext || !existing?.api_key_iv) {
          throw new ProfileInputError("请填写 API Key。");
        }
        await db
          .prepare(
            "UPDATE user_profiles SET base_url=?,model=?,updated_at=? WHERE user_email=?",
          )
          .bind(baseUrl, model, new Date().toISOString(), email)
          .run();
      }

      return { baseUrl, model, hasApiKey: true };
    },
  };
}
