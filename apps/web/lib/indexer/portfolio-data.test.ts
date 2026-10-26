import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Address } from "viem";

import type { PortfolioOrder, PortfolioTrade } from "../portfolio/activity";
import type * as Portfolio from "./portfolio-data";

const require = createRequire(import.meta.url);
const { fetchPortfolioOrders, fetchPortfolioTrades } = require("./portfolio-data.ts") as typeof Portfolio;
const account = `0x${"ab".repeat(20)}` as Address;
const id = `0x${"12".repeat(32)}` as const;
const baseOrder: PortfolioOrder = {
  id: "order",
  orderId: id,
  marketId: id,
  book: account,
  trader: account,
  side: "SELL",
  kind: "LIMIT",
  status: "CANCELLED",
  price: "1",
  quantity: "1",
  filledQuantity: "0",
  remainingQuantity: "0",
  quoteQuantity: "0",
  createdAt: 1,
  createdTxHash: id,
};

test("loads current orders in one filtered query despite more than 10,000 cancelled orders", async () => {
  const history = Array.from({ length: 10_001 }, (_, index) => ({ ...baseOrder, id: `cancelled-${index}` }));
  const open = ["OPEN", "PARTIALLY_FILLED", "QUARANTINED"].map((status, index) => ({
    ...baseOrder,
    id: `active-${index}`,
    status: status as PortfolioOrder["status"],
  }));
  let requests = 0;
  const request: Portfolio.PortfolioRequest = async <T>(_query: string, variables: Record<string, unknown>) => {
    requests++;
    assert.equal(variables.limit, 21);
    assert.equal(variables.offset, 0);
    const where = variables.where as { status: { _in: string[] }; trader: { _in: string[] } };
    assert.ok(where.trader._in.includes(account));
    assert.deepEqual(where.status._in, ["OPEN", "PARTIALLY_FILLED", "QUARANTINED"]);
    return {
      Order: [...history, ...open].filter((order) => where.status._in.includes(order.status)).slice(0, 21),
    } as T;
  };
  const result = await fetchPortfolioOrders(request, account, 0, true);
  assert.equal(requests, 1);
  assert.deepEqual(
    result.items.map((order) => order.id),
    ["active-0", "active-1", "active-2"],
  );
  assert.equal(result.hasMore, false);
});

test("requests only the selected history page beyond the former 10,000-order cap", async () => {
  let requests = 0;
  const request: Portfolio.PortfolioRequest = async <T>(_query: string, variables: Record<string, unknown>) => {
    requests++;
    assert.equal(variables.limit, 21);
    assert.equal(variables.offset, 15_000);
    assert.equal("status" in (variables.where as object), false);
    return { Order: Array.from({ length: 21 }, (_, index) => ({ ...baseOrder, id: `order-${15_000 + index}` })) } as T;
  };
  const result = await fetchPortfolioOrders(request, account, 750, false);
  assert.equal(requests, 1);
  assert.equal(result.items.length, 20);
  assert.equal(result.items[0]?.id, "order-15000");
  assert.equal(result.items.at(-1)?.id, "order-15019");
  assert.equal(result.hasMore, true);
});

test("queries maker and taker wallets directly without reading any order IDs", async () => {
  let requests = 0;
  const request: Portfolio.PortfolioRequest = async <T>(query: string, variables: Record<string, unknown>) => {
    requests++;
    assert.match(query, /makerTrader:.*_in: \$traders/);
    assert.match(query, /takerTrader:.*_in: \$traders/);
    assert.doesNotMatch(query, /\bOrder\(/);
    assert.deepEqual(variables.traders, [account]);
    assert.equal(variables.limit, 21);
    assert.equal(variables.offset, 20_000);
    return { Trade: [{ id: "old-order-new-fill" }] as PortfolioTrade[] } as T;
  };
  const result = await fetchPortfolioTrades(request, account, 1_000);
  assert.equal(requests, 1);
  assert.equal(result.items[0]?.id, "old-order-new-fill");
  assert.equal(result.hasMore, false);
});

test("rejects invalid pages before issuing an indexer query", async () => {
  const request: Portfolio.PortfolioRequest = async () => {
    throw new Error("Unexpected query");
  };
  for (const page of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 107_374_183]) {
    await assert.rejects(fetchPortfolioOrders(request, account, page, false), /Invalid portfolio page/);
    await assert.rejects(fetchPortfolioTrades(request, account, page), /Invalid portfolio page/);
  }
});

test("a failing trade query does not prevent fetching open orders or order history", async () => {
  const request: Portfolio.PortfolioRequest = async <T>(query: string) => {
    if (query.includes("PortfolioTrades")) throw new Error("Trade index unavailable");
    return { Order: [baseOrder] } as T;
  };
  const results = await Promise.allSettled([
    fetchPortfolioTrades(request, account, 0),
    fetchPortfolioOrders(request, account, 0, true),
    fetchPortfolioOrders(request, account, 0, false),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "fulfilled", "fulfilled"],
  );
});
