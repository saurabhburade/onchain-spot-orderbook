import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { enrichRecentTrades as enrichRecentTradesType } from "./trade-enrichment";

const require = createRequire(import.meta.url);
const { enrichRecentTrades } = require("./trade-enrichment.ts") as {
  enrichRecentTrades: typeof enrichRecentTradesType;
};

const takerOrderId = `0xbook:0x${"22".repeat(32)}`;
const account = `0x${"33".repeat(20)}`;

test("enriches recent trades with the taker account and side", () => {
  const [trade] = enrichRecentTrades(
    [{ id: "trade-1", takerOrderId }],
    [{ id: takerOrderId, trader: account, side: "SELL" }],
  );

  assert.equal(trade?.account, account);
  assert.equal(trade?.side, "SELL");
});

test("rejects a recent trade without its taker order", () => {
  assert.throws(
    () => enrichRecentTrades([{ id: "trade-1", takerOrderId }], []),
    new Error(`Indexer did not return taker order ${takerOrderId}`),
  );
});
