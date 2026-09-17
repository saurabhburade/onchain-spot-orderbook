import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { TradeExecuted } from "@/lib/clob";

const require = createRequire(import.meta.url);
const { aggregatePriceCandles, buildPriceCandles, deriveMarketSummary } =
  require("./market-stats.ts") as typeof import("./market-stats");

function trade(price: string, quoteQuantity: string, timestamp: number) {
  return { price, quoteQuantity, timestamp: BigInt(timestamp) } as TradeExecuted;
}

test("builds ordered 1-minute candles from market trades", () => {
  const candles = buildPriceCandles([trade("3", "4", 959), trade("2", "2", 950), trade("4", "1", 1_020)]);

  assert.deepEqual(candles, [
    { timestamp: 900, open: 2, high: 3, low: 2, close: 3, volume: 6 },
    { timestamp: 1_020, open: 4, high: 4, low: 4, close: 4, volume: 1 },
  ]);
});

test("aggregates 1-minute candles into ordered 15-minute OHLCV candles", () => {
  const candles = aggregatePriceCandles(
    [
      { timestamp: 960, open: 3, high: 5, low: 2, close: 4, volume: 7 },
      { timestamp: 900, open: 2, high: 4, low: 1, close: 3, volume: 5 },
      { timestamp: 1_800, open: 6, high: 7, low: 5, close: 6.5, volume: 2 },
    ],
    15 * 60,
  );

  assert.deepEqual(candles, [
    { timestamp: 900, open: 2, high: 5, low: 1, close: 4, volume: 12 },
    { timestamp: 1_800, open: 6, high: 7, low: 5, close: 6.5, volume: 2 },
  ]);
});

test("derives the selected market's last price and 24-hour metrics", () => {
  const now = 2_000_000;
  const summary = deriveMarketSummary(
    {
      poolId: "0x01",
      symbol: "BOOK / USDC",
      baseAsset: "BOOK",
      quoteAsset: "USDC",
      price: null,
    },
    [trade("100", "1", now - 86_401), trade("110", "2", now - 3_600), trade("120", "3", now - 60)],
    now,
  );

  assert.equal(summary.price, "120");
  assert.equal(summary.change, "+20.00%");
  assert.equal(summary.high, "120");
  assert.equal(summary.low, "110");
  assert.equal(summary.volume, "5 USDC");
});

test("leaves trade-backed metrics unavailable when there are no trades", () => {
  const summary = deriveMarketSummary(
    {
      poolId: "0x01",
      symbol: "BOOK / USDC",
      baseAsset: "BOOK",
      quoteAsset: "USDC",
      price: null,
    },
    [],
  );

  assert.equal(summary.price, null);
  assert.equal(summary.change, null);
  assert.equal(summary.volume, null);
});
