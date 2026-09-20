import type { MarketListing, PoolId } from "@/lib/clob/types";

import type { IndexedMarketDetail, IndexedRecentTradesPage } from "./queries";

export type IndexerSnapshot<T> = {
  data: T;
  error: string | null;
};

export type TradingIndexerSnapshot = {
  marketDetail: IndexerSnapshot<IndexedMarketDetail>;
  marketListings: IndexerSnapshot<MarketListing[]>;
  recentTrades: IndexerSnapshot<IndexedRecentTradesPage>;
  recentTradesPage: number;
};

export type TradingIndexerSnapshotInput = {
  chainId: number;
  marketId: PoolId;
  recentTradesPage: number;
  recentTradesPageSize: number;
};
