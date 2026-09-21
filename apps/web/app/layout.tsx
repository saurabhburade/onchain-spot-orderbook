import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { Providers } from "@/components/providers";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

export const metadata: Metadata = {
  metadataBase: siteUrl ? new URL(siteUrl) : undefined,
  title: "Permissionless spot exchange",
  description: "A permissionless fully on-chain spot exchange.",
  openGraph: {
    title: "Permissionless spot exchange",
    description: "A permissionless fully on-chain spot exchange.",
    images: [{ url: "/summary.png", width: 1200, height: 695, alt: "Onchain spot orderbook" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Permissionless spot exchange",
    description: "A permissionless fully on-chain spot exchange.",
    images: [{ url: "/summary.png", width: 1200, height: 695, alt: "Onchain spot orderbook" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={cn("antialiased font-sans", inter.variable)} lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <Providers>{children}</Providers>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
