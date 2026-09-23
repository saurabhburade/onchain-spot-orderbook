function decimalParts(value: string) {
  const [integer = "0", fraction = ""] = value.replaceAll(",", "").trim().split(".");
  return { integer: integer.replace(/^0+(?=\d)/, "") || "0", fraction };
}

function parseDecimal(value: string) {
  const { integer, fraction } = decimalParts(value);
  if (!/^\d+$/.test(integer) || (fraction && !/^\d+$/.test(fraction))) return null;
  return { fractionDigits: fraction.length, raw: BigInt(`${integer}${fraction}`) };
}

/**
 * Converts the entered base-asset size into its share of the spendable wallet
 * balance. Buy orders consume quote balance (size × price); sells consume base
 * balance directly. The percentage is rounded to two decimal places so the
 * slider label remains stable as the user types.
 */
export function deriveAllocationPercentage({
  amount,
  available,
  isBuy,
  price,
}: {
  amount: string;
  available: string;
  isBuy: boolean;
  price: string;
}) {
  const size = parseDecimal(amount);
  const balance = parseDecimal(available);
  const orderPrice = isBuy ? parseDecimal(price) : null;
  if (!size || !balance || balance.raw === 0n || (isBuy && (!orderPrice || orderPrice.raw === 0n))) return 0;

  const priceRaw = orderPrice?.raw ?? 1n;
  const priceFractionDigits = orderPrice?.fractionDigits ?? 0;
  const spent = isBuy ? size.raw * priceRaw : size.raw;
  const spentFractionDigits = size.fractionDigits + (isBuy ? priceFractionDigits : 0);
  const numerator = spent * 10n ** BigInt(balance.fractionDigits);
  const denominator = balance.raw * 10n ** BigInt(spentFractionDigits);

  // The range control ends at 100%; an excessive amount still surfaces the
  // validation error, while its handle communicates that it exceeds capacity.
  if (numerator >= denominator) return 100;

  // Keep two decimal places without converting token values through Number.
  const hundredths = (numerator * 10_000n + denominator / 2n) / denominator;
  return Number(hundredths) / 100;
}
