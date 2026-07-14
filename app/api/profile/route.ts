import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import {
  createProfileStore,
  ProfileInputError,
} from "../../lib/profile-store.mjs";

export const dynamic = "force-dynamic";

type RuntimeEnv = {
  DB: D1Database;
  PROFILE_ENCRYPTION_KEY?: string;
};

const runtime = env as unknown as RuntimeEnv;

function profileStore() {
  return createProfileStore({
    db: runtime.DB,
    encryptionSecret: runtime.PROFILE_ENCRYPTION_KEY,
  });
}

function serverError(error: unknown) {
  console.error("Profile request failed.", error);
  return Response.json(
    { error: "个人配置暂时不可用，请稍后重试。" },
    { status: 500 },
  );
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) {
    return Response.json({ authenticated: false }, { status: 401 });
  }

  try {
    const profile = await profileStore().getProfileSummary(user.email);
    return Response.json({ authenticated: true, user, profile });
  } catch (error) {
    return serverError(error);
  }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) {
    return Response.json({ error: "请先登录" }, { status: 401 });
  }

  let input: { baseUrl?: string; model?: string; apiKey?: string };
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "请求格式无效。" }, { status: 400 });
  }

  try {
    const profile = await profileStore().saveProfile(user.email, input);
    return Response.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof ProfileInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return serverError(error);
  }
}

