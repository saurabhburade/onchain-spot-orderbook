"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { type Address, getAddress } from "viem";

import { erc20Abi } from "@/lib/clob/abi";
import { useClobChain } from "@/lib/clob/chain-context";
import { useMarkets } from "@/lib/clob/hooks";
import { listedTokenIconUrl } from "@/lib/clob/market-list";
import type { MarketListing, PoolId, PoolMetadata } from "@/lib/clob/types";
import { formatPrice, formatQuote } from "@/lib/clob/utils";

import { summarizeIndexedTrades } from "./market-stats";
import { fetchIndexedMarketDetail, fetchIndexedMarkets, fetchIndexedOrderHistory } from "./queries";

const marketRefreshMs = 15_000;
const marketDetailRefreshMs = 5_000;

type TokenMetadata = {
  symbol: string;
  decimals: number;
};

async function readTokenMetadata(
  publicClient: ReturnType<typeof useClobChain>["publicClient"],
  addresses: Address[],
): Promise<Map<string, TokenMetadata>> {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))].map((address) => getAddress(address));
  if (unique.length === 0) return new Map();

  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: unique.flatMap((address) => [
      { address, abi: erc20Abi, functionName: "symbol" as const },
      { address, abi: erc20Abi, functionName: "decimals" as const },
    ]),
  });
  const metadata = new Map<string, TokenMetadata>();
  unique.forEach((address, index) => {
    const symbolResult = results[index * 2];
    const decimalsResult = results[index * 2 + 1];
    metadata.set(address.toLowerCase(), {
      symbol:
        symbolResult?.status === "success" && typeof symbolResult.result === "string"
          ? symbolResult.result
          : `${address.slice(0, 6)}…${address.slice(-4)}`,
      decimals:
        decimalsResult?.status === "success" && typeof decimalsResult.result === "number" ? decimalsResult.result : 18,
    });
  });
  return metadata;
}

export function useIndexerMarkets() {
  const { chainId, config, publicClient } = useClobChain();
  const query = useQuery({
    queryKey: ["indexer", "markets", chainId, config.indexerGraphqlUrl],
    queryFn: async ({ signal }): Promise<MarketListing[]> => {
      const indexed = await fetchIndexedMarkets(config.indexerGraphqlUrl, signal);
      const tokenMetadata = await readTokenMetadata(
        publicClient,
        indexed.Market.flatMap((market) => [market.baseAsset, market.quoteAsset]),
      );
      const tradesByMarket = new Map<string, typeof indexed.Trade>();
      for (const trade of indexed.Trade) {
        const key = trade.marketId.toLowerCase();
        const current = tradesByMarket.get(key);
        if (current) current.push(trade);
        else tradesByMarket.set(key, [trade]);
      }

      return indexed.Market.map((market) => {
        const base = tokenMetadata.get(market.baseAsset.toLowerCase());
        const quote = tokenMetadata.get(market.quoteAsset.toLowerCase());
        const metadata: PoolMetadata = {
          poolId: market.id,
          clobAddress: market.book,
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          baseSymbol: base?.symbol ?? "BASE",
          quoteSymbol: quote?.symbol ?? "QUOTE",
          baseDecimals: base?.decimals ?? market.baseDecimals,
          quoteDecimals: quote?.decimals ?? market.quoteDecimals,
          lotSize: BigInt(market.lotSize),
          tickSize: BigInt(market.tickSize),
          minTick: BigInt(market.minTick),
          maxTick: BigInt(market.maxTick),
          tradingFeeBps: market.tradingFeeBps,
          agnosticPricing: market.agnosticPricing,
        };
        const stats = summarizeIndexedTrades(tradesByMarket.get(market.id.toLowerCase()) ?? []);
        const indexedLastPrice = BigInt(market.lastPrice);

        return {
          ...metadata,
          baseIconUrl: listedTokenIconUrl(chainId, market.baseAsset),
          quoteIconUrl: listedTokenIconUrl(chainId, market.quoteAsset),
          bestBid: BigInt(market.bestBid) > 0n ? formatPrice(BigInt(market.bestBid), metadata) : null,
          bestAsk: BigInt(market.bestAsk) > 0n ? formatPrice(BigInt(market.bestAsk), metadata) : null,
          lastPrice: indexedLastPrice > 0n ? formatPrice(indexedLastPrice, metadata) : null,
          change24h: stats.change24h,
          volume24h: formatQuote(stats.quoteVolume24hRaw, metadata),
        } satisfies MarketListing;
      });
    },
    refetchOnMount: false,
    refetchInterval: marketRefreshMs,
  });

  return {
    data: query.data ?? [],
    error: query.error,
    loading: query.isPending,
    refetch: query.refetch,
  };
}

export function useRpcFirstMarkets() {
  const rpc = useMarkets();
  const indexed = useIndexerMarkets();
  const data = useMemo(() => {
    if (rpc.data.length === 0) return rpc.error ? indexed.data : [];

    const indexedById = new Map(indexed.data.map((market) => [market.poolId.toLowerCase(), market]));
    return rpc.data.map((market) => {
      const indexedMarket = indexedById.get(market.poolId.toLowerCase());
      return {
        ...market,
        lastPrice: indexedMarket?.lastPrice ?? market.lastPrice,
        change24h: indexedMarket?.change24h ?? market.change24h,
        volume24h: indexedMarket?.volume24h ?? market.volume24h,
      } satisfies MarketListing;
    });
  }, [indexed.data, rpc.data, rpc.error]);
  const refetch = useCallback(async () => {
    await Promise.allSettled([rpc.refetch(), indexed.refetch()]);
  }, [indexed.refetch, rpc.refetch]);

  return {
    data,
    error: data.length > 0 || rpc.loading || !rpc.error || indexed.loading ? null : (indexed.error ?? rpc.error),
    loading: data.length === 0 && (rpc.loading || (Boolean(rpc.error) && indexed.loading)),
    refetch,
  };
}

export function useIndexerMarketDetail(poolId?: PoolId) {
  const { chainId, config } = useClobChain();
  return useQuery({
    queryKey: ["indexer", "market-detail", chainId, poolId, config.indexerGraphqlUrl],
    queryFn: ({ signal }) => fetchIndexedMarketDetail(config.indexerGraphqlUrl, poolId as PoolId, signal),
    enabled: Boolean(poolId),
    refetchInterval: marketDetailRefreshMs,
  });
}

export function useIndexerOrderHistory(poolId?: PoolId, trader?: Address) {
  const { chainId, config } = useClobChain();
  return useQuery({
    queryKey: ["indexer", "order-history", chainId, poolId, trader?.toLowerCase(), config.indexerGraphqlUrl],
    queryFn: ({ signal }) =>
      fetchIndexedOrderHistory(config.indexerGraphqlUrl, poolId as PoolId, trader as Address, signal),
    enabled: Boolean(poolId && trader),
    refetchInterval: marketDetailRefreshMs,
  });
}
