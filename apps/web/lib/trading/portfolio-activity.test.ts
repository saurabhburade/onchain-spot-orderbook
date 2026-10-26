import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Address } from "viem";

import type * as Activity from "../portfolio/activity";

const require = createRequire(import.meta.url);
const { personalTradeLegs } = require("../portfolio/activity.ts") as typeof Activity;
const owner = `0x${"ab".repeat(20)}` as Address;
const peer = `0x${"cd".repeat(20)}` as Address;
const marketId = `0x${"34".repeat(32)}` as const;
const trade: Activity.PortfolioTrade = {
  id: "fill",
  marketId,
  book: peer,
  makerOrderId: "book:maker",
  takerOrderId: "book:taker",
  makerTrader: owner,
  takerTrader: peer,
  makerSide: "SELL",
  takerSide: "BUY",
  price: "100",
  quantity: "10",
  quoteQuantity: "1000",
  timestamp: 10,
  txHash: marketId,
};

test("uses the owner's maker side without fetching its historical order", () => {
  assert.deepEqual(personalTradeLegs(trade, owner.toUpperCase() as Address), [{ side: "SELL", role: "Maker" }]);
});

test("includes taker fills, ignores unrelated fills, and preserves both legs of a self-trade", () => {
  assert.deepEqual(personalTradeLegs(trade, peer), [{ side: "BUY", role: "Taker" }]);
  assert.deepEqual(personalTradeLegs({ ...trade, makerTrader: peer }, owner), []);
  assert.deepEqual(personalTradeLegs({ ...trade, takerTrader: owner }, owner), [
    { side: "SELL", role: "Maker" },
    { side: "BUY", role: "Taker" },
  ]);
});
