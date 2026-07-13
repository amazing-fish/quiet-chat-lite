import type { Metadata } from "next";
import "./globals.css";

const themeBootScript = `try{const saved=localStorage.getItem("quiet-chat:theme");const theme=saved==="light"||saved==="dark"?saved:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=theme}catch{}`;

export const metadata: Metadata = {
  title: "Quiet Chat · 轻量 AI 对话器",
  description: "一个只在本地保存对话、通过安全代理连接 OpenAI-compatible API 的轻量对话工具。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
