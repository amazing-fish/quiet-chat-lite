import { createProxyHandler } from "../../lib/proxy.mjs";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { createProfileStore } from "../../lib/profile-store.mjs";

export const dynamic = "force-dynamic";

type RuntimeEnv = {
  DB: D1Database;
  PROFILE_ENCRYPTION_KEY?: string;
};

const runtime = env as unknown as RuntimeEnv;

const handleProxyRequest = createProxyHandler({
  resolveCredentials: async () => {
    const user = await getChatGPTUser();
    if (!user) return null;
    return createProfileStore({
      db: runtime.DB,
      encryptionSecret: runtime.PROFILE_ENCRYPTION_KEY,
    }).getCredentials(user.email);
  },
});

export async function POST(request: Request) {
  return handleProxyRequest(request);
}
