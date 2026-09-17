type OrderBalanceInput = {
  side: "buy" | "sell";
  orderType: "limit" | "market";
  amount: string;
  price: string;
  available: string;
  symbol: string;
};

type Decimal = { raw: bigint; scale: number };

function parseDecimal(value: string): Decimal | null {
  const normalized = value.replaceAll(",", "").trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const [integer = "0", fraction = ""] = normalized.split(".");
  return {
    raw: BigInt(`${integer || "0"}${fraction}`),
    scale: fraction.length,
  };
}

function isGreaterThan(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  return left.raw * 10n ** BigInt(scale - left.scale) > right.raw * 10n ** BigInt(scale - right.scale);
}

export function validateOrderBalance(input: OrderBalanceInput): string | null {
  const amount = parseDecimal(input.amount);
  const available = parseDecimal(input.available);
  if (!amount || !available) return null;

  if (input.side === "sell") {
    return isGreaterThan(amount, available) ? `Insufficient ${input.symbol} balance.` : null;
  }

  // Market buys have no entered price, but the ticket supplies the current
  // market price as a reference. This prevents clearly unaffordable sizes
  // from reaching the wallet while execution still uses the on-chain price.
  const price = parseDecimal(input.price);
  if (!price) return input.orderType === "market" ? "Market price is unavailable." : null;
  const required = { raw: amount.raw * price.raw, scale: amount.scale + price.scale };
  return isGreaterThan(required, available) ? `Insufficient ${input.symbol} balance.` : null;
}
