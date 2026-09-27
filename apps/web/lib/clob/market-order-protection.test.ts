import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import type { PoolMetadata } from "./types";

const require = createRequire(import.meta.url);
const { marketOrderTerms, marketPriceLimit, parseSlippageBps, requiresSlippageRiskAcceptance } =
  require("./market-order-protection.ts") as typeof import("./market-order-protection");

const pool: PoolMetadata = {
  poolId: "0x0000000000000000000000000000000000000000000000000000000000000001",
  clobAddress: "0x0000000000000000000000000000000000000003",
  baseAsset: "0x0000000000000000000000000000000000000001",
  quoteAsset: "0x0000000000000000000000000000000000000002",
  baseSymbol: "BASE",
  quoteSymbol: "USDC",
  baseDecimals: 18,
  quoteDecimals: 6,
  lotSize: 1_000_000_000_000_000_000n,
  tickSize: 25_000n,
  minTick: 1n,
  maxTick: 1_000_000_000n,
  tradingFeeBps: 10,
  agnosticPricing: false,
};

describe("market order protection", () => {
  it("rounds slippage outward to valid ticks and converts base size to quote total", () => {
    const buy = marketOrderTerms({
      pool,
      side: "buy",
      quantity: "10",
      referencePriceRaw: 2_000_000n,
      slippagePercent: "1",
    });
    const sell = marketOrderTerms({
      pool,
      side: "sell",
      quantity: "10",
      referencePriceRaw: 2_000_000n,
      slippagePercent: "1",
    });
    assert.equal(buy.priceLimit, 2_025_000n);
    assert.equal(sell.priceLimit, 1_975_000n);
    assert.equal(buy.estimatedQuote, "20");
    assert.equal(buy.suggestedMinReceive, "9");
    assert.equal(buy.minFillQuantity, 9n);
    assert.equal(sell.suggestedMinReceive, "19.73025");
  });

  it("turns a custom sell-side quote minimum into an atomic minimum fill", () => {
    const terms = marketOrderTerms({
      pool: { ...pool, tickSize: 1n },
      side: "sell",
      quantity: "10",
      referencePriceRaw: 2_000_000n,
      slippagePercent: "1",
      minReceive: "9.89",
    });
    assert.equal(terms.priceLimit, 1_980_000n);
    assert.equal(terms.minFillQuantity, 5n);
    assert.throws(
      () =>
        marketOrderTerms({
          pool: { ...pool, tickSize: 1n },
          side: "sell",
          quantity: "10",
          referencePriceRaw: 2_000_000n,
          slippagePercent: "1",
          minReceive: "20",
        }),
      /exceeds what the selected slippage can guarantee/,
    );
  });

  it("changes buy minimum received when slippage changes", () => {
    const zero = marketOrderTerms({
      pool,
      side: "buy",
      quantity: "100",
      referencePriceRaw: 2_000_000n,
      slippagePercent: "0",
    });
    const twenty = marketOrderTerms({
      pool,
      side: "buy",
      quantity: "100",
      referencePriceRaw: 2_000_000n,
      slippagePercent: "20",
    });
    assert.equal(zero.suggestedMinReceive, "100");
    assert.equal(twenty.suggestedMinReceive, "83");
    assert.equal(twenty.minFillQuantity, 83n);
  });

  it("allows zero minimum received for an unrestricted market fill", () => {
    const terms = marketOrderTerms({
      pool,
      side: "buy",
      quantity: "10",
      referencePriceRaw: 2_000_000n,
      slippagePercent: "1",
      minReceive: "0",
    });
    assert.equal(terms.minReceive, "0");
    assert.equal(terms.minFillQuantity, 0n);
  });

  it("accounts for per-fill quote rounding in agnostic pools", () => {
    const terms = marketOrderTerms({
      pool: { ...pool, agnosticPricing: true, lotSize: 0n, tickSize: 0n },
      side: "sell",
      quantity: "10",
      referencePriceRaw: 2n * 10n ** 18n,
      slippagePercent: "0",
    });
    assert.equal(terms.priceLimit, 2n * 10n ** 18n);
    assert.equal(terms.suggestedMinReceive, "19.979938");
  });

  it("rejects invalid or unrepresentable user protections", () => {
    assert.equal(parseSlippageBps("0.25"), 25n);
    assert.equal(requiresSlippageRiskAcceptance("20"), false);
    assert.equal(requiresSlippageRiskAcceptance("20.01"), true);
    assert.equal(parseSlippageBps("90"), 9_000n);
    assert.throws(() => parseSlippageBps("90.01"), /cannot exceed 90/);
    assert.throws(() => parseSlippageBps("1.123"), /two decimal places/);
    assert.throws(() => marketPriceLimit(pool, "buy", 0n, 100n), /unavailable/);
    assert.equal(marketPriceLimit(pool, "sell", 2_000_000n, 9_000n), 200_000n);
    assert.throws(
      () =>
        marketOrderTerms({
          pool,
          side: "buy",
          quantity: "10",
          referencePriceRaw: 2_000_000n,
          slippagePercent: "1",
          minReceive: "11",
        }),
      /exceeds the order size/,
    );
  });
});
