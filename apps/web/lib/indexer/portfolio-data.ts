import type { Address } from "viem";

import type { PortfolioOrder, PortfolioTrade } from "../portfolio/activity";

export type PortfolioRequest = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
export const portfolioPageSize = 20;

const orderFields = `id orderId marketId book trader side kind status price quantity filledQuantity
  remainingQuantity quoteQuantity createdAt createdTxHash`;
const ordersQuery = `
  query PortfolioOrders($where: Order_bool_exp!, $limit: Int!, $offset: Int!) {
    Order(where: $where, order_by: [{ createdAt: desc }, { id: desc }], limit: $limit, offset: $offset) {
      ${orderFields}
    }
  }
`;
const tradesQuery = `
  query PortfolioTrades($traders: [String!]!, $limit: Int!, $offset: Int!) {
    Trade(where: { _or: [{ makerTrader: { _in: $traders } }, { takerTrader: { _in: $traders } }] },
      order_by: [{ timestamp: desc }, { blockNumber: desc }, { logIndex: desc }], limit: $limit, offset: $offset) {
      id marketId book makerOrderId takerOrderId makerTrader takerTrader makerSide takerSide
      price quantity quoteQuantity timestamp txHash
    }
  }
`;

function pageOffset(page: number) {
  const offset = page * portfolioPageSize;
  // GraphQL Int is signed 32-bit. This bounds a request, not an account's lifetime history.
  if (!Number.isSafeInteger(page) || page < 0 || offset > 2_147_483_647) throw new Error("Invalid portfolio page");
  return offset;
}

function tradersFor(account: Address) {
  return [...new Set([account, account.toLowerCase()])];
}

function resultPage<T>(items: T[]) {
  return { items: items.slice(0, portfolioPageSize), hasMore: items.length > portfolioPageSize };
}

export async function fetchPortfolioOrders(
  request: PortfolioRequest,
  account: Address,
  page: number,
  openOnly: boolean,
) {
  const where = {
    trader: { _in: tradersFor(account) },
    ...(openOnly ? { status: { _in: ["OPEN", "PARTIALLY_FILLED", "QUARANTINED"] } } : {}),
  };
  const data = await request<{ Order: PortfolioOrder[] }>(ordersQuery, {
    where,
    limit: portfolioPageSize + 1,
    offset: pageOffset(page),
  });
  return resultPage(data.Order);
}

export async function fetchPortfolioTrades(request: PortfolioRequest, account: Address, page: number) {
  const data = await request<{ Trade: PortfolioTrade[] }>(tradesQuery, {
    traders: tradersFor(account),
    limit: portfolioPageSize + 1,
    offset: pageOffset(page),
  });
  return resultPage(data.Trade);
}
