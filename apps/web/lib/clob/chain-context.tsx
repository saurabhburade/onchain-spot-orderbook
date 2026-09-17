"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

import { getClobEventClient, getClobPublicClient } from "./client";
import { type ClobNetworkConfig, getClobNetwork } from "./config";

type ClobChainContextValue = {
  chainId: number;
  config: ClobNetworkConfig;
  eventClient: ReturnType<typeof getClobEventClient>;
  publicClient: ReturnType<typeof getClobPublicClient>;
};

const ClobChainContext = createContext<ClobChainContextValue | null>(null);

export function ClobChainProvider({ chainId, children }: { chainId: number; children: ReactNode }) {
  const value = useMemo(
    () => ({
      chainId,
      config: getClobNetwork(chainId),
      eventClient: getClobEventClient(chainId),
      publicClient: getClobPublicClient(chainId),
    }),
    [chainId],
  );
  return <ClobChainContext.Provider value={value}>{children}</ClobChainContext.Provider>;
}

export function useClobChain() {
  const value = useContext(ClobChainContext);
  if (!value) throw new Error("useClobChain must be used inside a chain-scoped route");
  return value;
}
