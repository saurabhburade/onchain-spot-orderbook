"use client";

import { useAuthorizationSignature, usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { CircleCheck, Droplets, LoaderCircle } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { type Address, type ContractFunctionParameters, encodeFunctionData, formatUnits, type Hash } from "viem";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { erc20Abi, tokenFaucetAbi } from "@/config/abis";
import { MONAD_TESTNET_CHAIN_ID } from "@/config/constants";
import type { FaucetTokenConfig } from "@/config/contracts";
import { waitForTransaction } from "@/config/viem";
import { useClobChain, useClobWallet } from "@/lib/clob";
import { sendPrivySponsoredCalls, waitForPrivyTransaction } from "@/lib/clob/privy-wallet-api";
import { headlessTransactionOptions } from "@/lib/clob/transaction-options";

type TokenState = {
  claimAmount: bigint;
  cooldown: bigint;
  enabled: boolean;
  reserve: bigint;
  walletBalance: bigint;
  nextClaimAt: bigint;
};

const tokenIconUrls: Readonly<Record<string, string>> = {
  USDC: "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/monad/assets/0x754704Bc059F8C67012fEd69BC8A327a5aafb603/logo.png",
  USDT: "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Token claim failed";
}

function remainingLabel(nextClaimAt: bigint) {
  const remaining = Number(nextClaimAt) - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return "Ready to claim";
  return `Available in ${Math.ceil(remaining / 3600)}h`;
}

export function FaucetScreen() {
  const { chainId, config, publicClient } = useClobChain();
  const { authenticated, connect, ready, tradingAddress, wallet, walletId } = useClobWallet();
  const { getAccessToken } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const { generateAuthorizationSignature } = useAuthorizationSignature();
  const [states, setStates] = useState<Record<string, TokenState>>({});
  const [loadingToken, setLoadingToken] = useState<Address | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const faucet = config.faucetAddress;
    if (!faucet || config.faucetTokens.length === 0) return;
    setLoadingData(true);
    try {
      const contracts: ContractFunctionParameters[] = config.faucetTokens.flatMap((token) => {
        const shared: ContractFunctionParameters[] = [
          {
            address: faucet,
            abi: tokenFaucetAbi,
            functionName: "tokenConfig",
            args: [token.address],
          },
          {
            address: token.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [faucet],
          },
        ];
        if (!tradingAddress) return shared;
        return [
          ...shared,
          {
            address: token.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [tradingAddress],
          },
          {
            address: faucet,
            abi: tokenFaucetAbi,
            functionName: "nextClaimAt",
            args: [tradingAddress, token.address],
          },
        ];
      });
      const results = await publicClient.multicall({ allowFailure: false, contracts });
      const resultWidth = tradingAddress ? 4 : 2;
      const entries = config.faucetTokens.map((token, index) => {
        const offset = index * resultWidth;
        const tokenConfig = results[offset] as readonly [bigint, bigint, boolean];
        const reserve = results[offset + 1] as bigint;
        const walletBalance = tradingAddress ? (results[offset + 2] as bigint) : 0n;
        const nextClaimAt = tradingAddress ? (results[offset + 3] as bigint) : 0n;
        const [claimAmount, cooldown, enabled] = tokenConfig;
        return [
          token.address.toLowerCase(),
          { claimAmount, cooldown, enabled, reserve, walletBalance, nextClaimAt },
        ] as const;
      });
      setStates(Object.fromEntries(entries));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingData(false);
    }
  }, [config.faucetAddress, config.faucetTokens, publicClient, tradingAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = async (token: FaucetTokenConfig) => {
    const faucet = config.faucetAddress;
    if (!faucet) {
      setError(`Faucet is not configured for ${config.chain.name}`);
      return;
    }
    if (!wallet || !tradingAddress || !authenticated || !ready) {
      connect();
      return;
    }

    setLoadingToken(token.address);
    setError(null);
    setSuccess(null);
    try {
      const data = encodeFunctionData({
        abi: tokenFaucetAbi,
        functionName: "claim",
        args: [token.address],
      });
      let hash: Hash;
      if (chainId === MONAD_TESTNET_CHAIN_ID) {
        if (!walletId) throw new Error("The Privy embedded wallet is not ready");
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("Your Privy session expired before the faucet claim could be submitted");
        const transactionId = await sendPrivySponsoredCalls({
          accessToken,
          calls: [{ to: faucet, data }],
          chainId,
          generateAuthorizationSignature,
          walletId,
        });
        hash = await waitForPrivyTransaction({ walletId, transactionId, getAccessToken });
      } else {
        ({ hash } = await sendTransaction(
          { chainId, data, to: faucet },
          headlessTransactionOptions(wallet.address, chainId),
        ));
      }
      await waitForTransaction(chainId, hash);
      setSuccess(`${token.symbol} claimed successfully`);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingToken(null);
    }
  };

  const configured = Boolean(config.faucetAddress && config.faucetTokens.length);

  return (
    <div className="bg-background text-foreground">
      <main className="flex min-h-[calc(100dvh-6.75rem)] w-full flex-col lg:min-h-[calc(100dvh-4rem)]">
        <div className="grid flex-1 items-stretch border-b-[0.5px] border-border xl:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)]">
          <section className="relative isolate overflow-hidden border-b-[0.5px] border-border px-4 py-8 sm:px-6 lg:px-5 xl:border-r-[0.5px] xl:border-b-0 xl:px-8 xl:py-10">
            <Image
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-20 size-full object-cover object-center opacity-[0.22] mix-blend-multiply dark:invert dark:hue-rotate-180 dark:mix-blend-screen"
              fill
              priority
              sizes="(min-width: 1280px) 70vw, 100vw"
              src="/dither-space.png"
            />
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-background/45" />
            <div className="relative flex size-10 items-center justify-center rounded-xl bg-muted/90 backdrop-blur-sm">
              <Droplets aria-hidden="true" className="size-5" strokeWidth={1.5} />
            </div>
            <h1 className="relative mt-4 text-balance text-3xl font-semibold tracking-tight">Test token faucet</h1>
            <p className="relative mt-2 max-w-2xl text-pretty text-sm text-muted-foreground">
              Claim test USDC or USDT on {config.chain.name}. Each wallet can claim each token once per cooldown period.
            </p>
          </section>

          <section className="min-w-0">
            <div className="grid w-full">
              {config.faucetTokens.map((token) => {
                const state = states[token.address.toLowerCase()];
                const coolingDown = state ? state.nextClaimAt > BigInt(Math.floor(Date.now() / 1000)) : false;
                const claiming = loadingToken === token.address;
                return (
                  <Card
                    className="gap-0 rounded-none border-b-[0.5px] border-border bg-background py-0 ring-0 last:border-b-0"
                    key={token.address}
                  >
                    <CardHeader className="px-4 pt-4 sm:px-6 lg:px-5 xl:px-6">
                      <div className="relative flex size-10 items-center justify-center overflow-hidden rounded-full bg-foreground text-xs font-semibold text-background outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
                        {token.symbol.slice(0, 1)}
                        {tokenIconUrls[token.symbol] ? (
                          <Image
                            alt=""
                            aria-hidden="true"
                            className="object-cover"
                            fill
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                            sizes="40px"
                            src={tokenIconUrls[token.symbol]}
                          />
                        ) : null}
                      </div>
                      <CardTitle className="mt-3 text-lg">{token.symbol}</CardTitle>
                      <CardDescription className="break-all font-mono text-[11px]">{token.address}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4 px-4 pb-4 pt-4 sm:px-6 lg:px-5 xl:px-6">
                      <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/55 p-3 text-xs">
                        <div>
                          <p className="text-muted-foreground">Per claim</p>
                          <p className="mt-1 font-mono font-semibold tabular-nums">
                            {state ? formatUnits(state.claimAmount, token.decimals) : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Your balance</p>
                          <p className="mt-1 font-mono font-semibold tabular-nums">
                            {state ? formatUnits(state.walletBalance, token.decimals) : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Faucet reserve</p>
                          <p className="mt-1 font-mono tabular-nums">
                            {state ? formatUnits(state.reserve, token.decimals) : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Status</p>
                          <p className={`mt-1 font-medium ${coolingDown ? "text-amber-500" : "text-chart-3"}`}>
                            {state ? remainingLabel(state.nextClaimAt) : loadingData ? "Loading…" : "—"}
                          </p>
                        </div>
                      </div>
                      <Button
                        className="h-9 w-full rounded-full active:scale-[0.96]"
                        disabled={!configured || loadingData || claiming || coolingDown || state?.enabled === false}
                        onClick={() => void claim(token)}
                        size="default"
                      >
                        {claiming ? (
                          <LoaderCircle
                            aria-hidden="true"
                            className="animate-spin motion-reduce:animate-none"
                            data-icon="inline-start"
                          />
                        ) : null}
                        {claiming
                          ? "Claiming…"
                          : authenticated && wallet
                            ? `Claim ${token.symbol}`
                            : "Connect wallet to claim"}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            <div className="w-full px-4 pb-4 sm:px-6 lg:px-5 xl:px-6">
              {!configured ? (
                <p
                  className="mt-4 rounded-xl bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400"
                  role="status"
                >
                  The faucet is not configured for this network yet.
                </p>
              ) : null}
              {error ? (
                <p className="mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              {success ? (
                <p
                  className="mt-4 flex items-center gap-2 rounded-xl bg-chart-3/10 px-4 py-3 text-xs text-chart-3"
                  role="status"
                >
                  <CircleCheck aria-hidden="true" className="size-4" />
                  {success}
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
