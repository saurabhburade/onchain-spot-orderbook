"use client";

import type { ReactNode } from "react";

import { usePrivyConfigured } from "@/components/providers";
import { ClobChainProvider } from "@/lib/clob/chain-context";
import { ClobWalletProvider } from "@/lib/clob/wallet";

export function ChainRouteProviders({ chainId, children }: { chainId: number; children: ReactNode }) {
  const privyConfigured = usePrivyConfigured();
  return (
    <ClobChainProvider chainId={chainId}>
      {privyConfigured ? <ClobWalletProvider>{children}</ClobWalletProvider> : children}
    </ClobChainProvider>
  );
}
