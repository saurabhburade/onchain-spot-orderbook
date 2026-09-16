import type { MarketIntervalStats } from "envio";
import { candleStart } from "./candles.js";

export const MARKET_STATS_INTERVALS_SECONDS = [3_600, 86_400] as const;

type MarketIntervalStatsStore = {
  get(id: string): Promise<MarketIntervalStats | undefined>;
  set(entity: MarketIntervalStats): void;
};

export type MarketStatsDelta = Partial<
  Pick<
    MarketIntervalStats,
    | "orderPlacedCount"
    | "limitOrderCount"
    | "marketOrderCount"
    | "filledOrderCount"
    | "partialFillEventCount"
    | "cancelledOrderCount"
    | "tradeCount"
    | "lotVolume"
    | "baseVolume"
    | "quoteVolume"
    | "quoteFees"
  >
>;

type RecordMarketStatsInput = {
  store: MarketIntervalStatsStore;
  marketId: string;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  openOrderCountBefore: bigint;
  openOrderCountAfter: bigint;
  delta: MarketStatsDelta;
};

export function marketIntervalStatsEntityId(marketId: string, intervalSeconds: number, startTimestamp: number): string {
  return `${marketId}:${intervalSeconds}:${startTimestamp}`;
}

export async function recordMarketStats({
  store,
  marketId,
  timestamp,
  blockNumber,
  logIndex,
  txHash,
  openOrderCountBefore,
  openOrderCountAfter,
  delta,
}: RecordMarketStatsInput): Promise<void> {
  const intervals = await Promise.all(
    MARKET_STATS_INTERVALS_SECONDS.map(async (intervalSeconds) => {
      const startTimestamp = candleStart(timestamp, intervalSeconds);
      const id = marketIntervalStatsEntityId(marketId, intervalSeconds, startTimestamp);
      return {
        existing: await store.get(id),
        id,
        intervalSeconds,
        startTimestamp,
      };
    }),
  );

  for (const { existing, id, intervalSeconds, startTimestamp } of intervals) {
    const current = existing ?? {
      id,
      marketId,
      intervalSeconds,
      startTimestamp,
      endTimestamp: startTimestamp + intervalSeconds,
      orderPlacedCount: 0n,
      limitOrderCount: 0n,
      marketOrderCount: 0n,
      filledOrderCount: 0n,
      partialFillEventCount: 0n,
      cancelledOrderCount: 0n,
      tradeCount: 0n,
      openOrderCountStart: openOrderCountBefore,
      openOrderCountEnd: openOrderCountBefore,
      lotVolume: 0n,
      baseVolume: 0n,
      quoteVolume: 0n,
      quoteFees: 0n,
      firstBlock: blockNumber,
      lastBlock: blockNumber,
      firstLogIndex: logIndex,
      lastLogIndex: logIndex,
      firstTxHash: txHash,
      lastTxHash: txHash,
    };

    store.set({
      ...current,
      orderPlacedCount: current.orderPlacedCount + (delta.orderPlacedCount ?? 0n),
      limitOrderCount: current.limitOrderCount + (delta.limitOrderCount ?? 0n),
      marketOrderCount: current.marketOrderCount + (delta.marketOrderCount ?? 0n),
      filledOrderCount: current.filledOrderCount + (delta.filledOrderCount ?? 0n),
      partialFillEventCount: current.partialFillEventCount + (delta.partialFillEventCount ?? 0n),
      cancelledOrderCount: current.cancelledOrderCount + (delta.cancelledOrderCount ?? 0n),
      tradeCount: current.tradeCount + (delta.tradeCount ?? 0n),
      openOrderCountEnd: openOrderCountAfter,
      lotVolume: current.lotVolume + (delta.lotVolume ?? 0n),
      baseVolume: current.baseVolume + (delta.baseVolume ?? 0n),
      quoteVolume: current.quoteVolume + (delta.quoteVolume ?? 0n),
      quoteFees: current.quoteFees + (delta.quoteFees ?? 0n),
      lastBlock: blockNumber,
      lastLogIndex: logIndex,
      lastTxHash: txHash,
    });
  }
}
