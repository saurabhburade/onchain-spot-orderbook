"use client";

import {
  type ConnectedWallet,
  useConnectWallet,
  useLogin,
  useLogout,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { type Address, getAddress } from "viem";

import { useClobChain } from "./chain-context";
import { switchPrivyWalletToChain } from "./client";
import { getClobNetwork } from "./config";

type ClobWalletContextValue = {
  authenticated: boolean;
  connect: () => void;
  connected: boolean;
  connectionError: string | null;
  connecting: boolean;
  disconnect: () => Promise<void>;
  isCorrectChain: boolean;
  ready: boolean;
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
  connectionError: null,
  connecting: false,
  disconnect: async () => undefined,
  isCorrectChain: false,
  ready: false,
  switchToClobChain: async () => undefined,
  switchToChain: async () => undefined,
  wallet: null,
  walletId: null,
  tradingAddress: null,
};
const ClobWalletContext = createContext<ClobWalletContextValue>(defaultValue);

function messageFrom(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Wallet connection failed. Please try again.";
}

export function useClobWallet() {
  return useContext(ClobWalletContext);
}

export function ClobWalletProvider({ children }: { children: ReactNode }) {
  const { config } = useClobChain();
  const { authenticated, isModalOpen, ready: authReady, user } = usePrivy();
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
  const wallet = useMemo(() => {
    const ethereumWallets = wallets.filter((candidate) => candidate.type === "ethereum");
    return (
      ethereumWallets.find(
        (candidate) => candidate.walletClientType === "privy" || candidate.walletClientType === "privy-v2",
      ) ??
      ethereumWallets.find((candidate) => candidate.address.toLowerCase() === user?.wallet?.address?.toLowerCase()) ??
      ethereumWallets[0] ??
      null
    );
  }, [user?.wallet?.address, wallets]);
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
  const connected = authenticated && Boolean(wallet);
  const isCorrectChain = wallet?.chainId === `eip155:${config.chain.id}`;
  const connect = useCallback(() => {
    setConnectionError(null);
    if (authenticated) {
      connectWallet({
        description: "Choose the Ethereum wallet you want to use for Orderbook transactions.",
        walletChainType: "ethereum-only",
      });
      return;
    }
    login({ loginMethods: ["wallet"], walletChainType: "ethereum-only" });
  }, [authenticated, connectWallet, login]);
  const disconnect = useCallback(async () => {
    setConnectionError(null);
    await logout();
  }, [logout]);
  const switchToChain = useCallback(
    async (chainId: number) => {
      if (!wallet) throw new Error("Connect an Ethereum wallet first");
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
  const switchToClobChain = useCallback(() => switchToChain(config.chain.id), [config.chain.id, switchToChain]);

  return (
    <ClobWalletContext.Provider
      value={{
        authenticated,
        connect,
        connected,
        connectionError,
        connecting: isModalOpen,
        disconnect,
        isCorrectChain,
        ready,
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
