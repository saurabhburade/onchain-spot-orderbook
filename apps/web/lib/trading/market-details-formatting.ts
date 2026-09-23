export function formatLastPrice(value: string | null) {
  if (!value) return null;
  const numeric = Number.parseFloat(value.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Format an on-chain token amount without passing its full precision through Number. */
export function formatCurrencyAmount(value: string, fractionDigits = 2) {
  const normalized = value.replaceAll(",", "").trim();
  const match = normalized.match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) return value;

  const integer = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const precision = Math.max(0, fractionDigits);
  const raw = BigInt(`${integer}${fraction}`);
  const sourceScale = 10n ** BigInt(fraction.length);
  const targetScale = 10n ** BigInt(precision);
  const rounded =
    sourceScale > targetScale
      ? (raw * targetScale + sourceScale / 2n) / sourceScale
      : raw * (targetScale / sourceScale);
  const whole = (rounded / targetScale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (precision === 0) return whole;
  const decimal = (rounded % targetScale).toString().padStart(precision, "0");
  return `${whole}.${decimal}`;
}
