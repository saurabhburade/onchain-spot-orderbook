type TradeSide = "BUY" | "SELL";

export function enrichRecentTrades<TTrade extends { takerOrderId: string }, TAccount extends string>(
  trades: TTrade[],
  orders: { id: string; trader: TAccount; side: TradeSide }[],
) {
  const takerById = new Map(orders.map((order) => [order.id, order]));
  return trades.map((trade) => {
    const taker = takerById.get(trade.takerOrderId);
    if (!taker) throw new Error(`Indexer did not return taker order ${trade.takerOrderId}`);
    return { ...trade, account: taker.trader, side: taker.side };
  });
}
