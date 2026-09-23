import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { formatTradingFeeRate } = require("./trade-ticket-fee.ts") as typeof import("./trade-ticket-fee");

test("formats the selected market's configured fee instead of showing zero", () => {
  assert.equal(formatTradingFeeRate(10), "0.10%");
  assert.equal(formatTradingFeeRate(25), "0.25%");
  assert.equal(formatTradingFeeRate(100), "1.00%");
});
