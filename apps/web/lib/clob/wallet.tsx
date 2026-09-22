"use client";

import {
  type ConnectedWallet,
  useConnectWallet,
  useLogin,
  useLogout,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type Address, getAddress } from "viem";

import { getClobNetwork } from "@/config/chains";
import { switchPrivyWalletToChain } from "@/config/viem";
import { useClobChain } from "./chain-context";
import { warmDirectUserOperationAuth } from "./direct-userop-client";
import { clearKernelSessionKey, prepareKernelSessionKey } from "./kernel-session-client";

type ClobWalletContextValue = {
  authenticated: boolean;
  connect: () => void;
  connected: boolean;
  connectedEoaAddress: Address | null;
  connectedEoaWallet: ConnectedWallet | null;
  connectionError: string | null;
  connecting: boolean;
  disconnect: () => Promise<void>;
  disconnectEoa: () => void;
  isConnectedEoaCorrectChain: boolean;
  isCorrectChain: boolean;
  ready: boolean;
  switchConnectedEoaToClobChain: () => Promise<void>;
  switchToClobChain: () => Promise<void>;
  switchToChain: (chainId: number) => Promise<void>;
  wallet: ConnectedWallet | null;
  walletId: string | null;
  tradingAddress: Address | null;
};

const defaultValue: ClobWalletContextValue = {
  authenticated: false,
  connect: () => undefined,
  connected: false,
  connectedEoaAddress: null,
  connectedEoaWallet: null,
  connectionError: null,
  connecting: false,
  disconnect: async () => undefined,
  disconnectEoa: () => undefined,
  isConnectedEoaCorrectChain: false,
  isCorrectChain: false,
  ready: false,
  switchConnectedEoaToClobChain: async () => undefined,
  switchToClobChain: async () => undefined,
  switchToChain: async () => undefined,
  wallet: null,
  walletId: null,
  tradingAddress: null,
};
const ClobWalletContext = createContext<ClobWalletContextValue>(defaultValue);
const EOA_LOGOUT_GRACE_MS = 1_000;
// Privy's remote JWKS cache lasts 60 minutes. Refresh well before that so the
// next trade never has to pay the cold verification-key lookup.
const AUTH_WARM_INTERVAL_MS = 10 * 60 * 1_000;

function messageFrom(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Wallet connection failed. Please try again.";
}

export function useClobWallet() {
  return useContext(ClobWalletContext);
}

export function ClobWalletProvider({ children }: { children: ReactNode }) {
  const { config, publicClient } = useClobChain();
  const { authenticated, getAccessToken, isModalOpen, ready: authReady, user } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { login } = useLogin({
    onComplete: () => setConnectionError(null),
    onError: (error) => setConnectionError(messageFrom(error)),
  });
  const { connectWallet } = useConnectWallet({
    onSuccess: () => setConnectionError(null),
    onError: (error) => setConnectionError(messageFrom(error)),
  });
  const { logout } = useLogout();
  const { connectedEoaWallet, wallet } = useMemo(() => {
    const ethereumWallets = wallets.filter((candidate) => candidate.type === "ethereum");
    const isPrivyWallet = (candidate: ConnectedWallet) =>
      candidate.walletClientType === "privy" || candidate.walletClientType === "privy-v2";
    const privyWallet = ethereumWallets.find(isPrivyWallet) ?? null;
    const externalWallets = ethereumWallets.filter((candidate) => !isPrivyWallet(candidate));
    const connectedEoaWallet =
      externalWallets.find((candidate) => candidate.address.toLowerCase() === user?.wallet?.address?.toLowerCase()) ??
      externalWallets[0] ??
      null;
    return { connectedEoaWallet, wallet: privyWallet };
  }, [user?.wallet?.address, wallets]);
  const connectedEoaAddress = connectedEoaWallet ? getAddress(connectedEoaWallet.address) : null;
  const walletId = useMemo(() => {
    if (!wallet) return null;
    const account = user?.linkedAccounts.find(
      (candidate) =>
        candidate.type === "wallet" &&
        "address" in candidate &&
        candidate.address.toLowerCase() === wallet.address.toLowerCase() &&
        "walletClientType" in candidate &&
        (candidate.walletClientType === "privy" || candidate.walletClientType === "privy-v2"),
    );
    return account && "id" in account && typeof account.id === "string" ? account.id : null;
  }, [user?.linkedAccounts, wallet]);
  const tradingAddress = wallet ? getAddress(wallet.address) : null;
  const ready = authReady && walletsReady;
  const connected = authenticated && Boolean(wallet ?? connectedEoaWallet);
  const isConnectedEoaCorrectChain = connectedEoaWallet?.chainId === `eip155:${config.chain.id}`;
  const isCorrectChain = wallet?.chainId === `eip155:${config.chain.id}`;
  const connect = useCallback(() => {
    setConnectionError(null);
    if (authenticated) {
      connectWallet({
        description: "Choose the external EOA you want to connect to Orderbook.",
        walletChainType: "ethereum-only",
      });
      return;
    }
    login({ loginMethods: ["wallet"], walletChainType: "ethereum-only" });
  }, [authenticated, connectWallet, login]);
  const disconnect = useCallback(async () => {
    setConnectionError(null);
    clearKernelSessionKey();
    await logout();
  }, [logout]);

  useEffect(() => {
    if (!ready || !authenticated || !wallet || !tradingAddress || !isCorrectChain || config.chain.id !== 10_143) {
      return;
    }
    let cancelled = false;
    let renewalTimer: number | undefined;
    let authWarmPromise: Promise<void> | null = null;
    const warmAuthentication = () => {
      if (cancelled || authWarmPromise) return;
      authWarmPromise = getAccessToken()
        .then(async (accessToken) => {
          if (!accessToken || cancelled) return;
          await warmDirectUserOperationAuth({ chainId: config.chain.id, accessToken });
        })
        .catch((error) => console.warn("Could not warm the sponsored UserOperation authentication", error))
        .finally(() => {
          authWarmPromise = null;
        });
    };
    const warmAuthenticationWhenVisible = () => {
      if (document.visibilityState === "visible") warmAuthentication();
    };
    warmAuthentication();
    const authWarmTimer = window.setInterval(warmAuthentication, AUTH_WARM_INTERVAL_MS);
    window.addEventListener("focus", warmAuthentication);
    document.addEventListener("visibilitychange", warmAuthenticationWhenVisible);
    void wallet
      .getEthereumProvider()
      .then((provider) => {
        const authorizeSession = async () => {
          if (cancelled) return;
          try {
            const session = await prepareKernelSessionKey({
              chainId: config.chain.id,
              owner: tradingAddress,
              provider,
              publicClient: publicClient as never,
            });
            if (cancelled) return;
            const renewInMs = Math.max(1_000, session.validUntil * 1_000 - Date.now() + 1_000);
            renewalTimer = window.setTimeout(() => {
              clearKernelSessionKey(config.chain.id, tradingAddress);
              void authorizeSession();
            }, renewInMs);
          } catch (error) {
            // Transaction submission retains the lazy setup path, so a
            // transient login-time failure cannot make the wallet unusable.
            console.warn("Could not pre-authorize the Kernel session key", error);
          }
        };
        void authorizeSession();
      })
      .catch((error) => console.warn("Could not get the Privy provider for Kernel session setup", error));
    return () => {
      cancelled = true;
      window.clearInterval(authWarmTimer);
      window.removeEventListener("focus", warmAuthentication);
      document.removeEventListener("visibilitychange", warmAuthenticationWhenVisible);
      if (renewalTimer !== undefined) window.clearTimeout(renewalTimer);
    };
  }, [authenticated, config.chain.id, getAccessToken, isCorrectChain, publicClient, ready, tradingAddress, wallet]);

  useEffect(() => {
    if (!ready || !authenticated || isModalOpen || !tradingAddress || connectedEoaAddress) return;

    const timeout = window.setTimeout(() => {
      clearKernelSessionKey();
      void logout().catch((error) => setConnectionError(messageFrom(error)));
    }, EOA_LOGOUT_GRACE_MS);
    return () => window.clearTimeout(timeout);
  }, [authenticated, connectedEoaAddress, isModalOpen, logout, ready, tradingAddress]);

  const disconnectEoa = useCallback(() => {
    setConnectionError(null);
    connectedEoaWallet?.disconnect();
  }, [connectedEoaWallet]);
  const switchToChain = useCallback(
    async (chainId: number) => {
      if (!wallet) throw new Error("The Privy embedded wallet is not ready");
      setConnectionError(null);
      try {
        await switchPrivyWalletToChain(wallet, getClobNetwork(chainId));
      } catch (error) {
        const normalized = messageFrom(error);
        setConnectionError(normalized);
        throw new Error(normalized);
      }
    },
    [wallet],
  );
  const switchConnectedEoaToClobChain = useCallback(async () => {
    if (!connectedEoaWallet) throw new Error("Connect an external Ethereum wallet first");
    setConnectionError(null);
    try {
      await switchPrivyWalletToChain(connectedEoaWallet, config);
    } catch (error) {
      const normalized = messageFrom(error);
      setConnectionError(normalized);
      throw new Error(normalized);
    }
  }, [config, connectedEoaWallet]);
  const switchToClobChain = useCallback(() => switchToChain(config.chain.id), [config.chain.id, switchToChain]);

  return (
    <ClobWalletContext.Provider
      value={{
        authenticated,
        connect,
        connected,
        connectedEoaAddress,
        connectedEoaWallet,
        connectionError,
        connecting: isModalOpen,
        disconnect,
        disconnectEoa,
        isConnectedEoaCorrectChain,
        isCorrectChain,
        ready,
        switchConnectedEoaToClobChain,
        switchToClobChain,
        switchToChain,
        wallet,
        walletId,
        tradingAddress,
      }}
    >
      {children}
    </ClobWalletContext.Provider>
  );
}
