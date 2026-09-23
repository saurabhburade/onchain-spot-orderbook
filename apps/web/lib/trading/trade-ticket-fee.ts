export function formatTradingFeeRate(basisPoints: number) {
  return `${(basisPoints / 100).toFixed(2)}%`;
}
