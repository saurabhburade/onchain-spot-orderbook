import type { PrivyClientConfig } from "@privy-io/react-auth";

import { getClobNetwork, supportedClobNetworks } from "./chains";
import { DEFAULT_CLOB_CHAIN_ID } from "./constants";

export const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
export const privyClientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID;

/**
 * Build the PrivyProvider config for the active application theme.
 *
 * The chain registry is intentionally the source of truth here so adding a
 * supported CLOB chain does not require a second Privy-only list.
 */
export function getPrivyConfig(resolvedTheme: string | undefined): PrivyClientConfig {
  const walletList: Array<"detected_wallets" | "metamask" | "coinbase_wallet" | "wallet_connect"> = [
    "detected_wallets",
    "metamask",
    "coinbase_wallet",
    "wallet_connect",
  ];

  return {
    defaultChain: getClobNetwork(DEFAULT_CLOB_CHAIN_ID).chain,
    supportedChains: supportedClobNetworks.map((network) => network.chain),
    appearance: {
      theme: resolvedTheme === "dark" ? "dark" : "light",
      landingHeader: "Connect to Orderbook",
      loginMessage: "Connect an Ethereum wallet to create markets and trade.",
      showWalletLoginFirst: true,
      walletChainType: "ethereum-only" as const,
      walletList,
    },
    embeddedWallets: {
      ethereum: {
        createOnLogin: "all-users" as const,
      },
    },
    loginMethods: ["wallet"],
  };
}
