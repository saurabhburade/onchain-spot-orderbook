import type { TradeExecuted } from "@/lib/clob";

import type { MarketSummary } from "./market-data";

const candleIntervalSeconds = 60;
const daySeconds = 24 * 60 * 60;

export type PriceCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function numericTrade(trade: TradeExecuted) {
  const price = Number.parseFloat(trade.price);
  const volume = Number.parseFloat(trade.quoteQuantity);
  const timestamp = Number(trade.timestamp);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0
  ) {
    return null;
  }
  return { price, volume, timestamp };
}

export function compactNumber(value: number) {
  if (!Number.isFinite(value)) return "Not available";
  if (value !== 0 && (Math.abs(value) >= 1_000_000 || Math.abs(value) < 0.0001)) return value.toExponential(3);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6, maximumSignificantDigits: 7 }).format(value);
}

export function buildPriceCandles(trades: TradeExecuted[]): PriceCandle[] {
  const values = trades
    .flatMap((trade) => {
      const value = numericTrade(trade);
      return value ? [value] : [];
    })
    .toSorted((a, b) => a.timestamp - b.timestamp);
  const candles = new Map<number, PriceCandle>();

  for (const trade of values) {
    const timestamp = Math.floor(trade.timestamp / candleIntervalSeconds) * candleIntervalSeconds;
    const candle = candles.get(timestamp);
    if (candle) {
      candle.high = Math.max(candle.high, trade.price);
      candle.low = Math.min(candle.low, trade.price);
      candle.close = trade.price;
      candle.volume += trade.volume;
    } else {
      candles.set(timestamp, {
        timestamp,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.volume,
      });
    }
  }

  return [...candles.values()];
}

export function aggregatePriceCandles(candles: PriceCandle[], intervalSeconds: number): PriceCandle[] {
  const aggregated = new Map<number, PriceCandle>();

  for (const candle of candles.toSorted((a, b) => a.timestamp - b.timestamp)) {
    const timestamp = Math.floor(candle.timestamp / intervalSeconds) * intervalSeconds;
    const current = aggregated.get(timestamp);
    if (current) {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
    } else {
      aggregated.set(timestamp, { ...candle, timestamp });
    }
  }

  return [...aggregated.values()];
}

export function deriveMarketSummary(
  base: Omit<MarketSummary, "price" | "change" | "high" | "low" | "volume" | "volumeUsd"> & { price: string | null },
  trades: TradeExecuted[],
  nowSeconds = Math.floor(Date.now() / 1_000),
): MarketSummary {
  const values = trades
    .flatMap((trade) => {
      const value = numericTrade(trade);
      return value ? [value] : [];
    })
    .toSorted((a, b) => a.timestamp - b.timestamp);
  const last = values.at(-1);
  const cutoff = nowSeconds - daySeconds;
  const recent = values.filter((trade) => trade.timestamp >= cutoff && trade.timestamp <= nowSeconds);
  const previous = values.filter((trade) => trade.timestamp < cutoff).at(-1) ?? recent.at(0);
  const volume = recent.reduce((total, trade) => total + trade.volume, 0);
  const high = recent.length > 0 ? Math.max(...recent.map((trade) => trade.price)) : null;
  const low = recent.length > 0 ? Math.min(...recent.map((trade) => trade.price)) : null;
  const change =
    last && previous && previous.price > 0 && last.timestamp !== previous.timestamp
      ? ((last.price - previous.price) / previous.price) * 100
      : null;

  return {
    ...base,
    price: last ? compactNumber(last.price) : base.price,
    change: change === null ? null : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`,
    high: high === null ? null : compactNumber(high),
    low: low === null ? null : compactNumber(low),
    volume: recent.length === 0 ? null : `${compactNumber(volume)} ${base.quoteAsset}`,
    volumeUsd: null,
  };
}
