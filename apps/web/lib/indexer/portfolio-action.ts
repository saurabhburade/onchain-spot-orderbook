"use server";

import { getAddress, isAddress } from "viem";

import { isSupportedClobChainId } from "@/config/chains";
import type { PortfolioOrder, PortfolioTrade } from "@/lib/portfolio/activity";

import { requestIndexer } from "./client";
import { getIndexerGraphqlUrl } from "./server-config";

const orderFields = `id orderId marketId book trader side kind status price quantity filledQuantity
  remainingQuantity quoteQuantity createdAt createdTxHash`;
const ordersQuery = `
  query PortfolioOrders($traders: [String!]!, $after: String!, $limit: Int!) {
    Order(where: { trader: { _in: $traders }, id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) {
      ${orderFields}
    }
  }
`;
const tradesQuery = `
  query PortfolioTrades($ids: [String!]!, $limit: Int!, $offset: Int!) {
    Trade(where: { _or: [{ makerOrderId: { _in: $ids } }, { takerOrderId: { _in: $ids } }] },
      order_by: [{ timestamp: desc }, { blockNumber: desc }, { logIndex: desc }], limit: $limit, offset: $offset) {
      id marketId book makerOrderId takerOrderId price quantity quoteQuantity timestamp txHash
    }
  }
`;

export async function loadPortfolioActivity(input: { chainId: number; account: string; page: number }) {
  if (!Number.isSafeInteger(input.chainId) || !isSupportedClobChainId(input.chainId)) {
    throw new Error("Unsupported CLOB chain");
  }
  if (!isAddress(input.account)) throw new Error("Invalid trading address");
  if (!Number.isSafeInteger(input.page) || input.page < 0 || input.page > 500) throw new Error("Invalid trades page");

  const endpoint = getIndexerGraphqlUrl(input.chainId);
  const account = getAddress(input.account);
  const traders = [...new Set([account, account.toLowerCase()])];
  const signal = AbortSignal.timeout(20_000);
  const orders: PortfolioOrder[] = [];
  let after = "";
  // Read every owned order so fills of older resting orders and maker fills are included.
  for (;;) {
    const data = await requestIndexer<{ Order: PortfolioOrder[] }>(
      endpoint,
      ordersQuery,
      { traders, after, limit: 500 },
      signal,
    );
    orders.push(...data.Order);
    if (data.Order.length < 500) break;
    const cursor = data.Order.at(-1)?.id;
    if (!cursor || cursor <= after || orders.length >= 10_000) {
      throw new Error("This account's history is too large to load. View its activity in the explorer.");
    }
    after = cursor;
  }
  const trades = orders.length
    ? (
        await requestIndexer<{ Trade: PortfolioTrade[] }>(
          endpoint,
          tradesQuery,
          {
            ids: orders.map((order) => order.id),
            limit: 21,
            offset: input.page * 20,
          },
          signal,
        )
      ).Trade
    : [];
  return {
    orders: orders.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    trades: trades.slice(0, 20),
    hasMoreTrades: trades.length > 20,
  };
}
