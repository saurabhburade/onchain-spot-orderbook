import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Address } from "viem";

import type * as Activity from "../portfolio/activity";

const require = createRequire(import.meta.url);
const { personalTradeLegs } = require("../portfolio/activity.ts") as typeof Activity;
const owner = `0x${"ab".repeat(20)}` as Address;
const book = `0x${"ef".repeat(20)}` as Address;
const marketId = `0x${"34".repeat(32)}` as const;

function order(id: string, side: "BUY" | "SELL"): Activity.PortfolioOrder {
  return {
    id,
    orderId: marketId,
    marketId,
    book,
    trader: owner,
    side,
    kind: "LIMIT",
    status: "FILLED",
    price: "100",
    quantity: "10",
    filledQuantity: "10",
    remainingQuantity: "0",
    quoteQuantity: "1000",
    createdAt: 1,
    createdTxHash: marketId,
  };
}
const trade: Activity.PortfolioTrade = {
  id: "fill",
  marketId,
  book,
  makerOrderId: "book:maker",
  takerOrderId: "book:taker",
  price: "100",
  quantity: "10",
  quoteQuantity: "1000",
  timestamp: 10,
  txHash: marketId,
};

test("uses the owner's side for maker fills rather than the taker's opposite side", () => {
  const maker = order(trade.makerOrderId, "SELL");
  const [leg] = personalTradeLegs(trade, new Map([[maker.id, maker]]));
  assert.equal(leg?.role, "Maker");
  assert.equal(leg?.order.side, "SELL");
});

test("includes taker fills, ignores unrelated fills, and preserves both legs of a self-trade", () => {
  const maker = order(trade.makerOrderId, "SELL");
  const taker = order(trade.takerOrderId, "BUY");
  assert.deepEqual(personalTradeLegs(trade, new Map()), []);
  assert.equal(personalTradeLegs(trade, new Map([[taker.id, taker]]))[0]?.role, "Taker");
  assert.deepEqual(
    personalTradeLegs(
      trade,
      new Map([
        [maker.id, maker],
        [taker.id, taker],
      ]),
    ).map((leg) => leg.role),
    ["Maker", "Taker"],
  );
});
