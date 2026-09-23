import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { PoolMetadata } from "@/lib/clob";
import type { IndexedOrder } from "@/lib/indexer";

const require = createRequire(import.meta.url);
const { orderHistoryPrice } = require("./order-history.ts") as typeof import("./order-history");

const uint128Max = (1n << 128n) - 1n;

const pool: PoolMetadata = {
  poolId: `0x${"01".repeat(32)}`,
  clobAddress: `0x${"02".repeat(20)}`,
  baseAsset: `0x${"03".repeat(20)}`,
  quoteAsset: `0x${"04".repeat(20)}`,
  baseSymbol: "USDT",
  quoteSymbol: "USDC",
  baseDecimals: 6,
  quoteDecimals: 6,
  lotSize: 1n,
  tickSize: 1n,
  minTick: 1n,
  maxTick: 1n,
  tradingFeeBps: 10,
  agnosticPricing: true,
};

const differingDecimalsAgnosticPool: PoolMetadata = {
  ...pool,
  baseDecimals: 6,
  quoteDecimals: 18,
};

const legacyLotPool: PoolMetadata = {
  ...differingDecimalsAgnosticPool,
  agnosticPricing: false,
  lotSize: 10_000n,
};

function indexedOrder(overrides: Partial<IndexedOrder> = {}): IndexedOrder {
  return {
    id: "book:order",
    orderId: `0x${"05".repeat(32)}`,
    marketId: pool.poolId,
    book: pool.clobAddress,
    trader: `0x${"06".repeat(20)}`,
    side: "BUY",
    kind: "MARKET",
    status: "FILLED",
    price: uint128Max.toString(),
    quantity: "10000",
    filledQuantity: "10000",
    remainingQuantity: "0",
    quoteQuantity: "10050",
    expiry: "0",
    clientOrderId: "0",
    createdAt: 1_789_674_243,
    createdTxHash: `0x${"07".repeat(32)}`,
    updatedAt: 1_789_674_243,
    updatedTxHash: `0x${"07".repeat(32)}`,
    ...overrides,
  };
}

test("shows a market order's exact volume-weighted average execution price", () => {
  const order = indexedOrder();
  const price = orderHistoryPrice(order, pool, "340282366920938463463.374607431768211455");

  assert.equal(price, "1.005");
});

test("keeps an unfilled limit order's submitted limit price", () => {
  const order = indexedOrder({ kind: "LIMIT", filledQuantity: "0", price: "1001000000000000000", quoteQuantity: "0" });
  const price = orderHistoryPrice(order, pool, "1.001");

  assert.equal(price, "1.001");
});

test("uses an em dash for an unfilled market order", () => {
  const order = indexedOrder({ filledQuantity: "0", quoteQuantity: "0" });

  assert.equal(orderHistoryPrice(order, pool, "340282366920938463463.374607431768211455"), "—");
});

test("shows execution VWAP when a crossing limit order receives price improvement", () => {
  const order = indexedOrder({ kind: "LIMIT", price: "1001000000000000000", quoteQuantity: "9950" });

  assert.equal(orderHistoryPrice(order, pool, "1.001"), "0.995");
});

test("shows the volume-weighted average when a market order fills at multiple prices", () => {
  const order = indexedOrder({ filledQuantity: "20000", quantity: "20000", quoteQuantity: "20150" });

  assert.equal(orderHistoryPrice(order, pool, "340282366920938463463.374607431768211455"), "1.0075");
});

test("adjusts VWAP for different base and quote token decimals", () => {
  const order = indexedOrder({
    filledQuantity: "1000000",
    quantity: "1000000",
    quoteQuantity: "2000000000000000000",
  });

  assert.equal(orderHistoryPrice(order, differingDecimalsAgnosticPool, "—"), "2");
});

test("expands legacy filled lots before calculating VWAP", () => {
  const order = indexedOrder({
    filledQuantity: "100",
    quantity: "100",
    quoteQuantity: "2000000000000000000",
  });

  assert.equal(orderHistoryPrice(order, legacyLotPool, "—"), "2");
});
