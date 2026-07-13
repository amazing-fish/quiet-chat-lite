import { createProxyHandler } from "../../lib/proxy.mjs";

export const dynamic = "force-dynamic";

const handleProxyRequest = createProxyHandler();

export async function POST(request: Request) {
  return handleProxyRequest(request);
}
