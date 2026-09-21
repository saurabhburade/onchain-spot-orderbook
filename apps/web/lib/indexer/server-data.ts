import "server-only";

import { type Address, getAddress } from "viem";

import { erc20Abi } from "@/config/abis";
import { getClobPublicClient } from "@/config/viem";
import { listedTokenIconUrl } from "@/lib/clob/market-list";
import type { MarketListing, PoolMetadata } from "@/lib/clob/types";
import { formatPrice, formatQuote } from "@/lib/clob/utils";

import { summarizeIndexedTrades } from "./market-stats";
import type { IndexedMarketDetail } from "./queries";
import { fetchIndexedMarketDetail, fetchIndexedMarkets, fetchIndexedRecentTrades } from "./queries";
import { getIndexerGraphqlUrl } from "./server-config";
import type { IndexerSnapshot, TradingIndexerSnapshot, TradingIndexerSnapshotInput } from "./snapshot";

type TokenMetadata = {
  decimals: number;
  symbol: string;
};

async function loadSnapshot<T>(loader: () => Promise<T>, fallback: T): Promise<IndexerSnapshot<T>> {
  try {
    return { data: await loader(), error: null };
  } catch {
    return { data: fallback, error: "Indexer data is temporarily unavailable" };
  }
}

async function readTokenMetadata(chainId: number, addresses: Address[]) {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))].map((address) => getAddress(address));
  if (unique.length === 0) return new Map<string, TokenMetadata>();

  const results = await getClobPublicClient(chainId).multicall({
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

export async function fetchIndexedMarketListings(chainId: number): Promise<MarketListing[]> {
  const indexed = await fetchIndexedMarkets(getIndexerGraphqlUrl(chainId));
  console.log("indexed", indexed);
  const tokenMetadata = await readTokenMetadata(
    chainId,
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
}

export function loadIndexedMarketListings(chainId: number) {
  return loadSnapshot(() => fetchIndexedMarketListings(chainId), []);
}

export async function loadTradingIndexerSnapshot(input: TradingIndexerSnapshotInput): Promise<TradingIndexerSnapshot> {
  const endpoint = getIndexerGraphqlUrl(input.chainId);
  const [marketDetail, marketListings, recentTrades] = await Promise.all([
    loadSnapshot<IndexedMarketDetail>(() => fetchIndexedMarketDetail(endpoint, input.marketId), {
      market: null,
      dayTrades: [],
      candles: [],
    }),
    loadIndexedMarketListings(input.chainId),
    loadSnapshot(
      () => fetchIndexedRecentTrades(endpoint, input.marketId, input.recentTradesPage, input.recentTradesPageSize),
      { trades: [], totalCount: 0 },
    ),
  ]);

  return {
    marketDetail,
    marketListings,
    recentTrades,
    recentTradesPage: input.recentTradesPage,
  };
}
