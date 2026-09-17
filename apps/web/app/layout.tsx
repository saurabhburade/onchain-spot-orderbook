import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { Providers } from "@/components/providers";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Orderbook | Multichain spot exchange",
  description: "A multichain fully on-chain spot exchange.",
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
