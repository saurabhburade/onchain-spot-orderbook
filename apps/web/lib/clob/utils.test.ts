import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

type PoolMetadata = {
  poolId: `0x${string}`;
  baseAsset: `0x${string}`;
  quoteAsset: `0x${string}`;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  lotSize: bigint;
  tickSize: bigint;
  minTick: bigint;
  maxTick: bigint;
  tradingFeeBps: number;
  agnosticPricing: boolean;
};

const require = createRequire(import.meta.url);
const { formatPrice, formatQuantity, normalizeHumanAmount, parseHumanUnits, parsePriceToRaw, parseQuantityToLots } =
  require("./utils.ts") as {
    formatPrice: (priceRaw: bigint, pool: PoolMetadata) => string;
    formatQuantity: (quantityLots: bigint, pool: PoolMetadata) => string;
    normalizeHumanAmount: (value: string) => string;
    parseHumanUnits: (value: string, decimals: number) => bigint;
    parsePriceToRaw: (value: string, pool: PoolMetadata) => bigint;
    parseQuantityToLots: (value: string, pool: PoolMetadata) => bigint;
  };

const pool: PoolMetadata = {
  poolId: "0x0000000000000000000000000000000000000000000000000000000000000001",
  baseAsset: "0x0000000000000000000000000000000000000001",
  quoteAsset: "0x0000000000000000000000000000000000000002",
  baseSymbol: "BASE",
  quoteSymbol: "USDC",
  baseDecimals: 18,
  quoteDecimals: 6,
  lotSize: 1_000_000_000_000_000_000n,
  tickSize: 1n,
  minTick: 1n,
  maxTick: 1_000_000_000n,
  tradingFeeBps: 10,
  agnosticPricing: false,
};

describe("price unit conversion", () => {
  it("round-trips supply-agnostic prices and raw base quantities", () => {
    const agnosticPool = { ...pool, lotSize: 0n, tickSize: 0n, minTick: 0n, maxTick: 0n, agnosticPricing: true };
    const low = parsePriceToRaw("0.00000000001", agnosticPool);
    const high = parsePriceToRaw("1000000", agnosticPool);

    assert.equal(low, 10_000_000n);
    assert.equal(high, 1_000_000n * 10n ** 18n);
    assert.equal(formatPrice(low, agnosticPool), "0.00000000001");
    assert.equal(formatPrice(high, agnosticPool), "1000000");
    assert.equal(parseQuantityToLots("0.000000000001", agnosticPool), 1_000_000n);
    assert.equal(formatQuantity(1_000_000n, agnosticPool), "0.000000000001");
  });

  it("round-trips an 18-decimal base and 6-decimal quote price", () => {
    const rawPrice = parsePriceToRaw("0.4287", pool);
    assert.equal(rawPrice, 428_700n);
    assert.equal(formatPrice(rawPrice, pool), "0.4287");
  });

  it("supports a 0.0000001-token lot for an expensive 18-decimal token", () => {
    const expensivePool = { ...pool, lotSize: 100_000_000_000n, tickSize: 1n };
    const rawPrice = parsePriceToRaw("100000", expensivePool);

    assert.equal(parseQuantityToLots("0.0000001", expensivePool), 1n);
    assert.equal(rawPrice, 10_000n);
    assert.equal(formatPrice(rawPrice, expensivePool), "100000");
    assert.equal(formatQuantity(1n, expensivePool), "0.0000001");
  });

  it("supports a one-billion-token lot for a cheap 24-decimal token", () => {
    const cheapPool = {
      ...pool,
      baseDecimals: 24,
      lotSize: 1_000_000_000_000_000_000_000_000_000_000_000n,
      tickSize: 1n,
    };
    const rawPrice = parsePriceToRaw("0.000000005", cheapPool);

    assert.equal(parseQuantityToLots("1000000000", cheapPool), 1n);
    assert.equal(rawPrice, 5_000_000n);
    assert.equal(formatPrice(rawPrice, cheapPool), "0.000000005");
    assert.equal(formatQuantity(1n, cheapPool), "1000000000");
  });
});

describe("human amount input", () => {
  it("expands scientific and metric notation without floating-point conversion", () => {
    assert.equal(normalizeHumanAmount("1e-7"), "0.0000001");
    assert.equal(normalizeHumanAmount("1B"), "1000000000");
    assert.equal(normalizeHumanAmount("1.25B"), "1250000000");
    assert.equal(parseHumanUnits("1B", 24), 1_000_000_000_000_000_000_000_000_000_000_000n);
  });
});
