"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { createContext, type ReactNode, useContext, useState } from "react";

import { getPrivyConfig, privyAppId, privyClientId } from "@/config/privy";

const PrivyConfiguredContext = createContext(false);

export function usePrivyConfigured() {
  return useContext(PrivyConfiguredContext);
}

/**
 * Keeps the scaffold usable without Privy credentials while making the eventual
 * wallet boundary explicit. Privy owns the signer and sponsors Monad
 * transactions without creating a second user-facing account.
 */
export function Providers({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 15_000,
          },
        },
      }),
  );

  if (!privyAppId) {
    return (
      <QueryClientProvider client={queryClient}>
        <PrivyConfiguredContext.Provider value={false}>{children}</PrivyConfiguredContext.Provider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <PrivyProvider appId={privyAppId} clientId={privyClientId} config={getPrivyConfig(resolvedTheme)}>
        <PrivyConfiguredContext.Provider value>{children}</PrivyConfiguredContext.Provider>
      </PrivyProvider>
    </QueryClientProvider>
  );
}
