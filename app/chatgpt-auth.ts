import { headers } from "next/headers";
export type ChatGPTUser = { email: string; name: string };
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const h = await headers(); const email = h.get("oai-authenticated-user-email")?.trim();
  if (!email) return null;
  const encoded = h.get("oai-authenticated-user-full-name");
  let name = email;
  if (encoded && h.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") { try { name = decodeURIComponent(encoded); } catch {} }
  return { email, name };
}
