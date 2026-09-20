import type { PrivyClientConfig } from "@privy-io/react-auth";

import { getClobNetwork, supportedClobNetworks } from "./chains";
import { DEFAULT_CLOB_CHAIN_ID } from "./constants";

export const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
export const privyClientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID;

const privyAppearance = {
  dark: {
    accentColor: "#e5e5e5",
    theme: "#111111",
  },
  light: {
    accentColor: "#262626",
    theme: "#fafafa",
  },
} as const;

/**
 * Build the PrivyProvider config for the active application theme.
 *
 * The chain registry is intentionally the source of truth here so adding a
 * supported CLOB chain does not require a second Privy-only list.
 */
export function getPrivyConfig(resolvedTheme: string | undefined): PrivyClientConfig {
  const appearance = resolvedTheme === "dark" ? privyAppearance.dark : privyAppearance.light;
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
      ...appearance,
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
