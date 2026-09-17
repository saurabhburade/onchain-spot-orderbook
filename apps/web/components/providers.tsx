"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";

import { monadTestnetChain } from "@/lib/clob";

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const privyClientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID;
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
      <PrivyProvider
        appId={privyAppId}
        clientId={privyClientId}
        config={{
          defaultChain: monadTestnetChain,
          supportedChains: [monadTestnetChain],
          appearance: {
            landingHeader: "Connect to Orderbook",
            loginMessage: "Connect an Ethereum wallet to create markets and trade.",
            showWalletLoginFirst: true,
            walletChainType: "ethereum-only",
            walletList: ["detected_wallets", "metamask", "coinbase_wallet", "wallet_connect"],
          },
          embeddedWallets: {
            ethereum: {
              createOnLogin: "all-users",
            },
          },
          loginMethods: ["wallet"],
        }}
      >
        <PrivyConfiguredContext.Provider value>{children}</PrivyConfiguredContext.Provider>
      </PrivyProvider>
    </QueryClientProvider>
  );
}
