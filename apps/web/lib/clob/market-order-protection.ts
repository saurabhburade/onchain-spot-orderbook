import { parseUnits } from "viem";

import type { OrderSide, PoolMetadata } from "./types";
import { formatQuantity, formatQuote, parseQuantityToLots, quoteAmountRaw } from "./utils.ts";

const BPS = 10_000n;
const MAX_UINT128 = (1n << 128n) - 1n;
export const DEFAULT_MARKET_SLIPPAGE_PERCENT = "1";
export const MARKET_ORDER_MAX_BOOK_STEPS = 64n;
export const HIGH_SLIPPAGE_THRESHOLD_BPS = 2_000n;

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

export function parseSlippageBps(value: string) {
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) {
    throw new Error("Enter slippage as a percentage with up to two decimal places.");
  }
  const bps = parseUnits(normalized.startsWith(".") ? `0${normalized}` : normalized, 2);
  if (bps > 9_000n) throw new Error("Slippage cannot exceed 90%.");
  return bps;
}

export function requiresSlippageRiskAcceptance(value: string) {
  return parseSlippageBps(value) > HIGH_SLIPPAGE_THRESHOLD_BPS;
}

export function marketPriceLimit(pool: PoolMetadata, side: OrderSide, referencePriceRaw: bigint, slippageBps: bigint) {
  if (referencePriceRaw <= 0n || referencePriceRaw > MAX_UINT128) throw new Error("Market price is unavailable.");
  const scaled = referencePriceRaw * (side === "buy" ? BPS + slippageBps : slippageBps >= BPS ? 0n : BPS - slippageBps);
  const raw = side === "buy" ? ceilDiv(scaled, BPS) : scaled / BPS;
  if (pool.agnosticPricing) {
    const bounded = raw < 1n ? 1n : raw;
    if (bounded > MAX_UINT128) throw new Error("Slippage price exceeds the supported range.");
    return bounded;
  }
  if (pool.tickSize <= 0n) throw new Error("Market tick size is invalid.");
  const minPrice = pool.minTick * pool.tickSize;
  const maxPrice = pool.maxTick * pool.tickSize;
  const tickAligned =
    side === "buy" ? ceilDiv(raw, pool.tickSize) * pool.tickSize : (raw / pool.tickSize) * pool.tickSize;
  const bounded = tickAligned < minPrice ? minPrice : tickAligned > maxPrice ? maxPrice : tickAligned;
  if (bounded <= 0n || bounded > MAX_UINT128) throw new Error("Slippage price exceeds the supported range.");
  return bounded;
}

/** A lower bound that remains valid when agnostic-priced fills round down separately. */
function minimumNetQuote(pool: PoolMetadata, priceLimit: bigint, filledLots: bigint, maxBookSteps: bigint) {
  const aggregate = quoteAmountRaw(priceLimit, filledLots, pool);
  const roundingLoss = pool.agnosticPricing ? maxBookSteps - 1n : 0n;
  const gross = aggregate > roundingLoss ? aggregate - roundingLoss : 0n;
  if (pool.tradingFeeBps < 0 || pool.tradingFeeBps > 10_000) throw new Error("Market trading fee is invalid.");
  return gross - (gross * BigInt(pool.tradingFeeBps)) / BPS;
}

export type MarketOrderTerms = {
  quantity: bigint;
  priceLimit: bigint;
  minFillQuantity: bigint;
  estimatedQuote: string;
  suggestedMinReceive: string;
  minReceive: string;
};

export function marketOrderTerms(input: {
  pool: PoolMetadata;
  side: OrderSide;
  quantity: string;
  referencePriceRaw: bigint;
  slippagePercent: string;
  minReceive?: string;
  maxBookSteps?: bigint;
}): MarketOrderTerms {
  const { pool, side } = input;
  const quantity = parseQuantityToLots(input.quantity, pool);
  if (quantity > MAX_UINT128) throw new Error("Order quantity exceeds the supported range.");
  const maxBookSteps = input.maxBookSteps ?? MARKET_ORDER_MAX_BOOK_STEPS;
  if (maxBookSteps < 1n || maxBookSteps > 4_294_967_295n) throw new Error("Invalid order book step limit.");
  const priceLimit = marketPriceLimit(pool, side, input.referencePriceRaw, parseSlippageBps(input.slippagePercent));
  // A market buy names a maximum base size. Convert its quote value at the
  // reference price into the least base that the slippage price can buy.
  const buyMinimumLots = (quantity * input.referencePriceRaw) / priceLimit;
  const suggestedMinReceive =
    side === "buy"
      ? formatQuantity(buyMinimumLots > 0n ? buyMinimumLots : 1n, pool)
      : formatQuote(minimumNetQuote(pool, priceLimit, quantity, maxBookSteps), pool);
  const minReceive = input.minReceive?.trim() || suggestedMinReceive;
  if (minReceive === "0") {
    return {
      quantity,
      priceLimit,
      minFillQuantity: 0n,
      estimatedQuote: formatQuote(quoteAmountRaw(input.referencePriceRaw, quantity, pool), pool),
      suggestedMinReceive,
      minReceive,
    };
  }
  let minFillQuantity: bigint;
  if (side === "buy") {
    minFillQuantity = parseQuantityToLots(minReceive, pool);
  } else {
    let requestedQuote: bigint;
    try {
      requestedQuote = parseUnits(minReceive, pool.quoteDecimals);
    } catch {
      throw new Error(`Enter minimum received in ${pool.quoteSymbol} with valid precision.`);
    }
    if (requestedQuote <= 0n) throw new Error("Minimum received must be greater than zero.");
    if (requestedQuote > minimumNetQuote(pool, priceLimit, quantity, maxBookSteps)) {
      throw new Error("Minimum received exceeds what the selected slippage can guarantee.");
    }
    let low = 1n;
    let high = quantity;
    while (low < high) {
      const middle = (low + high) / 2n;
      if (minimumNetQuote(pool, priceLimit, middle, maxBookSteps) >= requestedQuote) high = middle;
      else low = middle + 1n;
    }
    minFillQuantity = low;
  }
  if (minFillQuantity <= 0n || minFillQuantity > quantity) {
    throw new Error("Minimum received exceeds the order size.");
  }
  return {
    quantity,
    priceLimit,
    minFillQuantity,
    estimatedQuote: formatQuote(quoteAmountRaw(input.referencePriceRaw, quantity, pool), pool),
    suggestedMinReceive,
    minReceive,
  };
}
