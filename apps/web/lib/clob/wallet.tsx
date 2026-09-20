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

import { getClobNetwork } from "@/config/chains";
import { switchPrivyWalletToChain } from "@/config/viem";
import { useClobChain } from "./chain-context";

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
    await logout();
  }, [logout]);
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
