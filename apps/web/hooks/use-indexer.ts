"use client";

import { useCallback, useMemo } from "react";

import { useMarkets } from "@/hooks/use-clob";
import type { MarketListing } from "@/lib/clob/types";

export function useRpcFirstMarkets(
  indexedMarkets: MarketListing[] = [],
  indexerError?: string | null,
  refreshIndexer?: () => void,
  indexerLoading = false,
) {
  const rpc = useMarkets();
  const data = useMemo(() => {
    if (rpc.data.length === 0) return indexedMarkets;

    const indexedById = new Map(indexedMarkets.map((market) => [market.poolId.toLowerCase(), market]));
    return rpc.data.map((market) => {
      const indexedMarket = indexedById.get(market.poolId.toLowerCase());
      return {
        ...market,
        lastPrice: indexedMarket?.lastPrice ?? market.lastPrice,
        change24h: indexedMarket?.change24h ?? market.change24h,
        volume24h: indexedMarket?.volume24h ?? market.volume24h,
      } satisfies MarketListing;
    });
  }, [indexedMarkets, rpc.data]);
  const refetch = useCallback(async () => {
    refreshIndexer?.();
    await rpc.refetch();
  }, [refreshIndexer, rpc.refetch]);

  return {
    data,
    error: data.length > 0 || rpc.loading ? null : indexerError ? new Error(indexerError) : rpc.error,
    loading: data.length === 0 && (rpc.loading || indexerLoading),
    refetch,
  };
}
