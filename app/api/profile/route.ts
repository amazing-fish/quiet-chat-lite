import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { profileSchema } from "../../../db/schema";
type RuntimeEnv = { DB: D1Database; PROFILE_ENCRYPTION_KEY: string };
const runtime = env as unknown as RuntimeEnv;
const b64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
const bytes = (v: string) => Uint8Array.from(atob(v), c => c.charCodeAt(0));
async function key() { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runtime.PROFILE_ENCRYPTION_KEY)); return crypto.subtle.importKey("raw", d, "AES-GCM", false, ["encrypt", "decrypt"]); }
async function encrypt(v: string) { const iv = crypto.getRandomValues(new Uint8Array(12)); const c = await crypto.subtle.encrypt({name:"AES-GCM",iv}, await key(), new TextEncoder().encode(v)); return {c:b64(new Uint8Array(c)),iv:b64(iv)}; }
async function decrypt(c: string, iv: string) { const p = await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(iv)}, await key(), bytes(c)); return new TextDecoder().decode(p); }
async function user() { const u = await getChatGPTUser(); if (u) await runtime.DB.prepare(profileSchema).run(); return u; }
export async function GET() {
  const u=await user(); if(!u) return Response.json({authenticated:false},{status:401});
  const r=await runtime.DB.prepare("SELECT base_url,model,api_key_ciphertext,api_key_iv FROM user_profiles WHERE user_email=?").bind(u.email).first<{base_url:string;model:string;api_key_ciphertext:string;api_key_iv:string}>();
  return Response.json({authenticated:true,user:u,profile:r?{baseUrl:r.base_url,model:r.model,apiKey:await decrypt(r.api_key_ciphertext,r.api_key_iv)}:null});
}
export async function PUT(request:Request) {
  const u=await user(); if(!u) return Response.json({error:"请先登录"},{status:401});
  const x=await request.json() as {baseUrl?:string;model?:string;apiKey?:string}; const base=x.baseUrl?.trim(), model=x.model?.trim(), api=x.apiKey?.trim();
  if(!base||!model||!api) return Response.json({error:"配置不完整"},{status:400}); const s=await encrypt(api);
  await runtime.DB.prepare("INSERT INTO user_profiles(user_email,base_url,model,api_key_ciphertext,api_key_iv,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_email) DO UPDATE SET base_url=excluded.base_url,model=excluded.model,api_key_ciphertext=excluded.api_key_ciphertext,api_key_iv=excluded.api_key_iv,updated_at=excluded.updated_at").bind(u.email,base,model,s.c,s.iv,new Date().toISOString()).run();
  return Response.json({ok:true});
}
