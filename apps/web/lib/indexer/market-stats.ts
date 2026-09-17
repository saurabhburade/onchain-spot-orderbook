import type { IndexedTrade } from "./queries";

export type RawMarketStats = {
  change24h: number | null;
  lastPriceRaw: bigint | null;
  quoteVolume24hRaw: bigint;
};

export function summarizeIndexedTrades(trades: IndexedTrade[]): RawMarketStats {
  if (trades.length === 0) {
    return { change24h: null, lastPriceRaw: null, quoteVolume24hRaw: 0n };
  }

  const ordered = trades.toSorted((left, right) =>
    left.timestamp === right.timestamp ? left.logIndex - right.logIndex : left.timestamp - right.timestamp,
  );
  const firstPrice = BigInt(ordered[0].price);
  const lastPriceRaw = BigInt(ordered.at(-1)?.price ?? ordered[0].price);
  const quoteVolume24hRaw = ordered.reduce((total, trade) => total + BigInt(trade.quoteQuantity), 0n);
  const change24h = firstPrice > 0n ? (Number(lastPriceRaw - firstPrice) / Number(firstPrice)) * 100 : null;

  return { change24h, lastPriceRaw, quoteVolume24hRaw };
}
