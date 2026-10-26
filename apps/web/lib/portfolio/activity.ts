import type { Address, Hash } from "viem";

export type PortfolioOrder = {
  id: string;
  orderId: `0x${string}`;
  marketId: `0x${string}`;
  book: Address;
  trader: Address;
  side: "BUY" | "SELL";
  kind: "LIMIT" | "MARKET";
  status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "QUARANTINED";
  price: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  quoteQuantity: string;
  createdAt: number;
  createdTxHash: Hash;
};

export type PortfolioTrade = {
  id: string;
  marketId: `0x${string}`;
  book: Address;
  makerOrderId: string;
  takerOrderId: string;
  price: string;
  quantity: string;
  quoteQuantity: string;
  timestamp: number;
  txHash: Hash;
};

export function personalTradeLegs(trade: PortfolioTrade, orders: Map<string, PortfolioOrder>) {
  const legs: { order: PortfolioOrder; role: "Maker" | "Taker" }[] = [];
  const maker = orders.get(trade.makerOrderId.toLowerCase());
  const taker = orders.get(trade.takerOrderId.toLowerCase());
  if (maker) legs.push({ order: maker, role: "Maker" });
  if (taker) legs.push({ order: taker, role: "Taker" });
  return legs;
}
