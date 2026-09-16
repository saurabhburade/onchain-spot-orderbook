export const CANDLE_INTERVALS_SECONDS = [60, 300, 900, 3_600, 14_400, 86_400] as const;

export function candleStart(timestamp: number, intervalSeconds: number): number {
  return Math.floor(timestamp / intervalSeconds) * intervalSeconds;
}

export function candleEntityId(marketId: string, intervalSeconds: number, startTimestamp: number): string {
  return `${marketId}:${intervalSeconds}:${startTimestamp}`;
}
