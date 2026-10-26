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
  makerTrader: Address;
  takerTrader: Address;
  makerSide: "BUY" | "SELL";
  takerSide: "BUY" | "SELL";
  price: string;
  quantity: string;
  quoteQuantity: string;
  timestamp: number;
  txHash: Hash;
};

export function personalTradeLegs(trade: PortfolioTrade, account: Address | null) {
  const legs: { side: "BUY" | "SELL"; role: "Maker" | "Taker" }[] = [];
  if (!account) return legs;
  const owner = account.toLowerCase();
  if (trade.makerTrader.toLowerCase() === owner) legs.push({ side: trade.makerSide, role: "Maker" });
  if (trade.takerTrader.toLowerCase() === owner) legs.push({ side: trade.takerSide, role: "Taker" });
  return legs;
}
