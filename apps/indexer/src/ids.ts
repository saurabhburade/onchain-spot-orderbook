export function orderEntityId(book: string, orderId: string): string {
  return `${book}:${orderId}`;
}

export function eventEntityId(transactionHash: string, logIndex: number): string {
  return `${transactionHash}:${logIndex}`;
}

export function bookUpdateEntityId(marketId: string, sequence: bigint): string {
  return `${marketId}:${sequence}`;
}

export function orderSide(side: bigint | number): "BUY" | "SELL" {
  return Number(side) === 0 ? "BUY" : "SELL";
}
