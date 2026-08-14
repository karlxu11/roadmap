import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "路书 · ROAM NOTE",
    description: "把每一天，排成一条好走的路。一个清晰易用的多日自驾行程工作台。",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "路书 · ROAM NOTE",
      description: "把每一天，排成一条好走的路。",
      images: [{ url: `${origin}/og.png`, width: 1732, height: 908, alt: "路书多日自驾行程工作台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "路书 · ROAM NOTE",
      description: "把每一天，排成一条好走的路。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
