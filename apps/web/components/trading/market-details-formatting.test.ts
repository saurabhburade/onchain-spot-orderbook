import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { formatCurrencyAmount, formatLastPrice } =
  require("./market-details-formatting.ts") as typeof import("./market-details-formatting");

test("formats last price with no more than four decimal places", () => {
  assert.equal(formatLastPrice("1"), "1");
  assert.equal(formatLastPrice("1.2000"), "1.2");
  assert.equal(formatLastPrice("1.234567"), "1.2346");
});

test("formats wallet currency with separators and two rounded decimal places", () => {
  assert.equal(formatCurrencyAmount("5545.259096"), "5,545.26");
  assert.equal(formatCurrencyAmount("12345678901234567890.995"), "12,345,678,901,234,567,891.00");
  assert.equal(formatCurrencyAmount("5"), "5.00");
});
