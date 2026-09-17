import type { Address, Hash } from "viem";

import type { PoolId } from "@/lib/clob/types";

import { requestIndexer } from "./client";
import { enrichRecentTrades } from "./trade-enrichment";

export type IndexedMarket = {
  id: PoolId;
  book: Address;
  baseAsset: Address;
  quoteAsset: Address;
  lotSize: string;
  tickSize: string;
  minTick: string;
  maxTick: string;
  tradingFeeBps: number;
  baseDecimals: number;
  quoteDecimals: number;
  agnosticPricing: boolean;
  bestBid: string;
  bestAsk: string;
  lastPrice: string;
  lastTradeAt: number;
  createdAt: number;
};

export type IndexedTrade = {
  id: string;
  marketId: PoolId;
  book: Address;
  makerOrderId: PoolId;
  takerOrderId: PoolId;
  baseAsset: Address;
  quoteAsset: Address;
  price: string;
  quantity: string;
  quoteQuantity: string;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: Hash;
};

export type IndexedRecentTrade = IndexedTrade & {
  account: Address;
  side: "BUY" | "SELL";
};

export type IndexedOrder = {
  id: string;
  orderId: PoolId;
  marketId: PoolId;
  book: Address;
  trader: Address;
  side: "BUY" | "SELL";
  kind: "LIMIT" | "MARKET";
  status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
  price: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  quoteQuantity: string;
  expiry: string;
  clientOrderId: string;
  createdAt: number;
  createdTxHash: Hash;
  updatedAt: number;
  updatedTxHash: Hash;
};

export type IndexedCandle = {
  id: string;
  marketId: PoolId;
  intervalSeconds: number;
  startTimestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  quoteVolume: string;
  tradeCount: number;
};

export type IndexedMarketDetail = {
  market: IndexedMarket | null;
  dayTrades: IndexedTrade[];
  latestTrades: IndexedRecentTrade[];
  candles: IndexedCandle[];
};

const marketFields = `
  id
  book
  baseAsset
  quoteAsset
  lotSize
  tickSize
  minTick
  maxTick
  tradingFeeBps
  baseDecimals
  quoteDecimals
  agnosticPricing
  bestBid
  bestAsk
  lastPrice
  lastTradeAt
  createdAt
`;

const tradeFields = `
  id
  marketId
  book
  makerOrderId
  takerOrderId
  baseAsset
  quoteAsset
  price
  quantity
  quoteQuantity
  timestamp
  blockNumber
  logIndex
  txHash
`;

const marketListQuery = `
  query MarketList($from: Int!, $marketLimit: Int!, $tradeLimit: Int!) {
    Market(order_by: { createdAt: desc }, limit: $marketLimit) {
      ${marketFields}
    }
    Trade(where: { timestamp: { _gte: $from } }, order_by: [{ timestamp: asc }, { logIndex: asc }], limit: $tradeLimit) {
      ${tradeFields}
    }
  }
`;

const marketDetailQuery = `
  query MarketDetail($marketId: String!, $from: Int!, $tradeLimit: Int!, $candleInterval: Int!, $candleLimit: Int!) {
    Market(where: { id: { _eq: $marketId } }, limit: 1) {
      ${marketFields}
    }
    dayTrades: Trade(
      where: { marketId: { _eq: $marketId }, timestamp: { _gte: $from } }
      order_by: [{ timestamp: asc }, { logIndex: asc }]
      limit: $tradeLimit
    ) {
      ${tradeFields}
    }
    latestTrades: Trade(
      where: { marketId: { _eq: $marketId } }
      order_by: [{ timestamp: desc }, { logIndex: desc }]
      limit: 50
    ) {
      ${tradeFields}
    }
    MarketCandle(
      where: { marketId: { _eq: $marketId }, intervalSeconds: { _eq: $candleInterval } }
      order_by: { startTimestamp: desc }
      limit: $candleLimit
    ) {
      id
      marketId
      intervalSeconds
      startTimestamp
      open
      high
      low
      close
      quoteVolume
      tradeCount
    }
  }
`;

const takerOrdersQuery = `
  query TakerOrders($ids: [String!]!) {
    Order(where: { id: { _in: $ids } }) {
      id
      trader
      side
    }
  }
`;

const orderHistoryQuery = `
  query OrderHistory($marketId: String!, $traders: [String!]!, $limit: Int!) {
    Order(
      where: { marketId: { _eq: $marketId }, trader: { _in: $traders } }
      order_by: [{ createdAt: desc }, { orderId: desc }]
      limit: $limit
    ) {
      id
      orderId
      marketId
      book
      trader
      side
      kind
      status
      price
      quantity
      filledQuantity
      remainingQuantity
      quoteQuantity
      expiry
      clientOrderId
      createdAt
      createdTxHash
      updatedAt
      updatedTxHash
    }
  }
`;

const daySeconds = 24 * 60 * 60;
export const marketChartCandleIntervalSeconds = 60;

export async function fetchIndexedMarkets(endpoint: string, signal?: AbortSignal) {
  return requestIndexer<{ Market: IndexedMarket[]; Trade: IndexedTrade[] }>(
    endpoint,
    marketListQuery,
    {
      from: Math.floor(Date.now() / 1_000) - daySeconds,
      marketLimit: 500,
      tradeLimit: 10_000,
    },
    signal,
  );
}

export async function fetchIndexedMarketDetail(endpoint: string, marketId: PoolId, signal?: AbortSignal) {
  const data = await requestIndexer<{
    Market: IndexedMarket[];
    dayTrades: IndexedTrade[];
    latestTrades: IndexedTrade[];
    MarketCandle: IndexedCandle[];
  }>(
    endpoint,
    marketDetailQuery,
    {
      marketId,
      from: Math.floor(Date.now() / 1_000) - daySeconds,
      tradeLimit: 10_000,
      candleInterval: marketChartCandleIntervalSeconds,
      candleLimit: 160,
    },
    signal,
  );

  const takerOrderIds = [...new Set(data.latestTrades.map((trade) => trade.takerOrderId))];
  const takerOrders = takerOrderIds.length
    ? await requestIndexer<{
        Order: { id: string; trader: Address; side: "BUY" | "SELL" }[];
      }>(endpoint, takerOrdersQuery, { ids: takerOrderIds }, signal)
    : { Order: [] };
  const latestTrades = enrichRecentTrades(data.latestTrades, takerOrders.Order) satisfies IndexedRecentTrade[];

  return {
    market: data.Market[0] ?? null,
    dayTrades: data.dayTrades,
    latestTrades,
    candles: data.MarketCandle.toReversed(),
  } satisfies IndexedMarketDetail;
}

export async function fetchIndexedOrderHistory(
  endpoint: string,
  marketId: PoolId,
  trader: Address,
  signal?: AbortSignal,
) {
  const traders = [...new Set([trader, trader.toLowerCase()])];
  const data = await requestIndexer<{ Order: IndexedOrder[] }>(
    endpoint,
    orderHistoryQuery,
    { marketId, traders, limit: 500 },
    signal,
  );
  return data.Order;
}
