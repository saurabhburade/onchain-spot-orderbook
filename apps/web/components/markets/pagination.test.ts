import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { getMarketPage, marketsPerPage } = require("./pagination.ts") as typeof import("./pagination");

test("shows at most ten markets per page", () => {
  const markets = Array.from({ length: 21 }, (_, index) => index + 1);

  assert.equal(marketsPerPage, 10);
  assert.deepEqual(getMarketPage(markets, 1).items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(getMarketPage(markets, 2).items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(getMarketPage(markets, 3).items, [21]);
});

test("uses a single page for ten or fewer markets", () => {
  assert.equal(getMarketPage(Array.from({ length: 9 }), 1).pageCount, 1);
  assert.equal(getMarketPage(Array.from({ length: 10 }), 1).pageCount, 1);
  assert.equal(getMarketPage(Array.from({ length: 11 }), 1).pageCount, 2);
});

test("clamps a stale requested page after filtering", () => {
  const page = getMarketPage(["market"], 4);

  assert.equal(page.currentPage, 1);
  assert.deepEqual(page.items, ["market"]);
  assert.equal(page.startIndex, 0);
});
