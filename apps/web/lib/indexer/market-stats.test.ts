import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type { IndexedTrade } from "./queries";

const require = createRequire(import.meta.url);
const { summarizeIndexedTrades } = require("./market-stats.ts") as typeof import("./market-stats");

function trade(price: string, quoteQuantity: string, timestamp: number, logIndex = 0) {
  return { price, quoteQuantity, timestamp, logIndex } as IndexedTrade;
}

test("summarizes indexed trades into last price, 24-hour change, and quote volume", () => {
  const summary = summarizeIndexedTrades([
    trade("120000000000000000000", "3000000", 300, 2),
    trade("100000000000000000000", "1000000", 100),
    trade("110000000000000000000", "2000000", 200),
  ]);

  assert.equal(summary.lastPriceRaw, 120000000000000000000n);
  assert.equal(summary.change24h, 20);
  assert.equal(summary.quoteVolume24hRaw, 6000000n);
});

test("returns an empty summary when a market has no recent trades", () => {
  assert.deepEqual(summarizeIndexedTrades([]), {
    change24h: null,
    lastPriceRaw: null,
    quoteVolume24hRaw: 0n,
  });
});
