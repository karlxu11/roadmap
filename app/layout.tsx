import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "路书 · ROAM NOTE",
  description: "一个更容易编辑多日行程的高德路书工作台。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
