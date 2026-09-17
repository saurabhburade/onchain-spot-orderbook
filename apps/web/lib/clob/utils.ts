import { type Address, formatUnits, parseUnits } from "viem";

import type { PoolMetadata } from "./types";

const metricExponent: Record<string, number> = { k: 3, m: 6, b: 9, t: 12 };
export const TRADING_FEE_BPS = 10n;
export const BPS_DENOMINATOR = 10_000n;

export function quoteAmountWithTakerFee(quoteAmount: bigint) {
  return quoteAmount + (quoteAmount * TRADING_FEE_BPS) / BPS_DENOMINATOR;
}

export function quoteAmountRaw(priceRaw: bigint, quantityRaw: bigint, pool: PoolMetadata) {
  if (!pool.agnosticPricing) return priceRaw * quantityRaw;
  const exponent = 18 + pool.baseDecimals - pool.quoteDecimals;
  if (exponent < 0) throw new Error("Unsupported base/quote decimal relationship");
  return (priceRaw * quantityRaw) / decimalPower(exponent);
}

export function quoteAmountWithPoolFee(quoteAmount: bigint, pool: PoolMetadata) {
  return quoteAmount + (quoteAmount * BigInt(pool.tradingFeeBps)) / BPS_DENOMINATOR;
}

export function decimalPower(decimals: number) {
  return 10n ** BigInt(decimals);
}

/** Expand exact decimal, scientific, or metric input without passing through Number. */
export function normalizeHumanAmount(value: string) {
  const compact = value.trim().replace(/[,_\s]/g, "");
  const match = compact.match(/^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?([kKmMbBtT])?$/);
  if (!match || (!match[1] && !match[2])) throw new Error("Enter a valid token amount");

  const integer = match[1] || "0";
  const fraction = match[2] || "";
  const scientific = match[3] ? Number.parseInt(match[3], 10) : 0;
  const metric = match[4] ? metricExponent[match[4].toLowerCase()] : 0;
  const exponent = scientific + metric;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error("Token amount exponent is too large");
  }

  const normalizedInteger = integer.replace(/^0+(?=\d)/, "") || "0";
  const digits = `${normalizedInteger}${fraction}`;
  const point = normalizedInteger.length + exponent;
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function parseHumanUnits(value: string, decimals: number) {
  return parseUnits(normalizeHumanAmount(value), decimals);
}

export function formatFraction(numerator: bigint, denominator: bigint, maxFractionDigits = 18) {
  if (denominator === 0n) throw new Error("Cannot format a fraction with a zero denominator");
  const scale = decimalPower(maxFractionDigits);
  const scaled = (numerator * scale) / denominator;
  const integer = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(maxFractionDigits, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

export function formatPrice(priceRaw: bigint, pool: PoolMetadata) {
  if (pool.agnosticPricing) return formatFraction(priceRaw, 10n ** 18n, 24);
  return formatFraction(
    priceRaw * decimalPower(pool.baseDecimals),
    pool.lotSize * decimalPower(pool.quoteDecimals),
    Math.min(24, Math.max(8, pool.baseDecimals + pool.quoteDecimals)),
  );
}

export function formatQuantity(quantityLots: bigint, pool: PoolMetadata) {
  if (pool.agnosticPricing) return formatUnits(quantityLots, pool.baseDecimals);
  return formatUnits(quantityLots * pool.lotSize, pool.baseDecimals);
}

export function formatQuote(quantityRaw: bigint, pool: PoolMetadata) {
  return formatUnits(quantityRaw, pool.quoteDecimals);
}

export function parseQuantityToLots(value: string, pool: PoolMetadata) {
  const atoms = parseUnits(value, pool.baseDecimals);
  if (pool.agnosticPricing) {
    if (atoms <= 0n) throw new Error("Quantity must be positive");
    return atoms;
  }
  if (atoms <= 0n || atoms % pool.lotSize !== 0n) {
    throw new Error(
      `Quantity must be a positive multiple of one base lot (${formatUnits(pool.lotSize, pool.baseDecimals)} ${pool.baseSymbol})`,
    );
  }
  return atoms / pool.lotSize;
}

export function parsePriceToRaw(value: string, pool: PoolMetadata) {
  if (pool.agnosticPricing) {
    const priceX18 = parseUnits(normalizeHumanAmount(value), 18);
    if (priceX18 <= 0n || priceX18 > (1n << 128n) - 1n) {
      throw new Error("Price is outside the supported 128-bit range");
    }
    return priceX18;
  }
  const scaled = parseUnits(value, pool.quoteDecimals + pool.baseDecimals);
  // `scaled` is P * 10^(quoteDecimals + baseDecimals). The contract stores
  // P * 10^quoteDecimals quote atoms per base lot, so account for the base
  // token's raw-atom scale and the lot size explicitly.
  const denominator = decimalPower(pool.baseDecimals) ** 2n;
  const numerator = scaled * pool.lotSize;
  if (numerator % denominator !== 0n) {
    throw new Error("Price has more precision than the token decimals and lot size allow");
  }
  const price = numerator / denominator;
  if (price <= 0n || price % pool.tickSize !== 0n) {
    throw new Error(`Price must be a positive multiple of the tick size (${pool.tickSize.toString()} raw)`);
  }
  return price;
}

export function resolveAsset(asset: "base" | "quote" | Address, pool: PoolMetadata) {
  if (asset === "base") return pool.baseAsset;
  if (asset === "quote") return pool.quoteAsset;
  return asset;
}

export function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
