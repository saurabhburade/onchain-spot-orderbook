type HistoryPriceOrder = {
  kind: "LIMIT" | "MARKET";
  filledQuantity: string;
  quoteQuantity: string;
};

type HistoryPricePool = {
  agnosticPricing: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  lotSize: bigint;
};

export function orderHistoryPrice(order: HistoryPriceOrder, pool: HistoryPricePool, formattedLimitPrice: string) {
  const filledQuantity = BigInt(order.filledQuantity);
  if (filledQuantity === 0n) return order.kind === "LIMIT" ? formattedLimitPrice : "—";

  const rawBaseQuantity = pool.agnosticPricing ? filledQuantity : filledQuantity * pool.lotSize;
  const numerator = BigInt(order.quoteQuantity) * 10n ** BigInt(pool.baseDecimals);
  const denominator = rawBaseQuantity * 10n ** BigInt(pool.quoteDecimals);
  const maxFractionDigits = Math.min(24, Math.max(8, pool.baseDecimals + pool.quoteDecimals));
  const scale = 10n ** BigInt(maxFractionDigits);
  const scaled = (numerator * scale) / denominator;
  const integer = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(maxFractionDigits, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}
