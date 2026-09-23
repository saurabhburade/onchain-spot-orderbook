export type OrderSide = "buy" | "sell";
export type OrderType = "limit" | "market";

export type MarketSummary = {
  poolId: `0x${string}`;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  price: string | null;
  change: string | null;
  high: string | null;
  low: string | null;
  volume: string | null;
  volumeUsd: string | null;
};

export type OrderBookLevel = {
  price: string;
  size: string;
  total: string;
  depth: number;
};

export type RecentTrade = {
  id: string;
  time: string;
  timestampMs: number;
  market: string;
  price: string;
  size: string;
  side: OrderSide;
  account: string;
  transactionHash?: string;
};

export type OpenOrder = {
  orderId: `0x${string}`;
  market: string;
  side: OrderSide;
  type: string;
  price: string;
  amount: string;
  filled: string;
  status: string;
  time: string;
  transactionHash?: string;
};

export type ChartPoint = {
  id?: string;
  label: string;
  value: number;
};

export type Balance = {
  symbol: string;
  free: string;
  locked: string;
  wallet?: string;
};

export type TransactionFeedback = {
  status: "idle" | "pending" | "submitted" | "success" | "error";
  message?: string;
  hash?: string;
};

export type TradeMarketData = {
  summary: MarketSummary;
  chart: ChartPoint[];
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  recentTrades: RecentTrade[];
  openOrders: OpenOrder[];
  quoteBalance: Balance | null;
  baseBalance: Balance | null;
  loading: boolean;
  error: string | null;
};

export type TradeActions = {
  submitLimitOrder?: (input: { side: OrderSide; price: string; quantity: string }) => Promise<void>;
  submitMarketOrder?: (input: { side: OrderSide; quantity: string }) => Promise<void>;
  cancelOrder?: (orderId: `0x${string}`) => Promise<void>;
};
