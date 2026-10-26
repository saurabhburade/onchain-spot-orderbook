"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { Address } from "viem";

import { clobAbi, erc20Abi } from "@/config/abis";
import { subscribeToBalanceRefresh } from "@/lib/clob/balance-refresh";
import { useClobChain } from "@/lib/clob/chain-context";
import type { MarketListing } from "@/lib/clob/types";
import { loadPortfolioActivity } from "@/lib/indexer/portfolio-action";
import { readPortfolioBalanceSnapshot } from "@/lib/portfolio/balance-snapshot";

export function usePortfolio(markets: MarketListing[], tradesPage: number, account: Address | null) {
  const { chainId, config, publicClient } = useClobChain();
  const tradingAddress = account;
  const queryClient = useQueryClient();
  const enabled = Boolean(tradingAddress);
  const tokens = useMemo(() => {
    const unique = new Map(config.tokens.map((token) => [token.address.toLowerCase(), token]));
    for (const market of markets) {
      unique.set(market.baseAsset.toLowerCase(), {
        address: market.baseAsset,
        symbol: market.baseSymbol,
        decimals: market.baseDecimals,
      });
      unique.set(market.quoteAsset.toLowerCase(), {
        address: market.quoteAsset,
        symbol: market.quoteSymbol,
        decimals: market.quoteDecimals,
      });
    }
    return [...unique.values()];
  }, [config.tokens, markets]);
  const escrows = useMemo(() => {
    const pairs = new Map<string, { book: Address; asset: Address }>();
    for (const market of markets) {
      for (const asset of [market.baseAsset, market.quoteAsset]) {
        pairs.set(`${market.clobAddress.toLowerCase()}:${asset.toLowerCase()}`, { book: market.clobAddress, asset });
      }
    }
    return [...pairs.values()];
  }, [markets]);
  const scope = [chainId, tradingAddress] as const;
  const balances = useQuery({
    queryKey: ["portfolio-balances", ...scope, tokens, escrows],
    enabled,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!tradingAddress) throw new Error("Connect your trading wallet");
      const { native, results } = await readPortfolioBalanceSnapshot(publicClient, tradingAddress, [
        ...tokens.map((token) => ({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [tradingAddress],
        })),
        ...escrows.map(({ book, asset }) => ({
          address: book,
          abi: clobAbi,
          functionName: "balanceOf" as const,
          args: [tradingAddress, asset],
        })),
      ]);
      return [
        {
          key: "native",
          symbol: config.chain.nativeCurrency.symbol,
          decimals: config.chain.nativeCurrency.decimals,
          address: null,
          wallet: native,
          locked: 0n,
        },
        ...tokens.map((token, index) => {
          const result = results[index];
          let escrow: bigint | null = 0n;
          for (let i = 0; i < escrows.length; i++) {
            if (escrows[i].asset.toLowerCase() !== token.address.toLowerCase()) continue;
            const entry = results[tokens.length + i];
            if (entry?.status !== "success") {
              escrow = null;
              break;
            }
            escrow += (entry.result as readonly [bigint, bigint, bigint])[1];
          }
          return {
            ...token,
            key: token.address.toLowerCase(),
            wallet: result?.status === "success" ? (result.result as bigint) : null,
            locked: escrow,
          };
        }),
      ];
    },
  });
  const activity = useQuery({
    queryKey: ["portfolio-activity", ...scope, tradesPage],
    enabled,
    retry: 1,
    refetchInterval: 15_000,
    queryFn: () => loadPortfolioActivity({ chainId, account: tradingAddress ?? "", page: tradesPage }),
  });
  useEffect(
    () =>
      subscribeToBalanceRefresh(() => {
        void queryClient.invalidateQueries({ queryKey: ["portfolio-balances", chainId, tradingAddress] });
        void queryClient.invalidateQueries({ queryKey: ["portfolio-activity", chainId, tradingAddress] });
      }),
    [chainId, queryClient, tradingAddress],
  );
  return { balances, activity };
}
