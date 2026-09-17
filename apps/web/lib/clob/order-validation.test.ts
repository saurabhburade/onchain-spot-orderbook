import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { validateOrderBalance } = require("./order-validation.ts") as typeof import("./order-validation");

test("rejects a sell larger than the available base balance", () => {
  assert.equal(
    validateOrderBalance({
      side: "sell",
      orderType: "limit",
      amount: "222",
      price: "1.00",
      available: "150",
      symbol: "BOOK",
    }),
    "Insufficient BOOK balance.",
  );
});

test("accepts a sell equal to the available base balance", () => {
  assert.equal(
    validateOrderBalance({
      side: "sell",
      orderType: "limit",
      amount: "150",
      price: "1.00",
      available: "150",
      symbol: "BOOK",
    }),
    null,
  );
});

test("rejects a limit buy whose quote total exceeds the available balance", () => {
  assert.equal(
    validateOrderBalance({
      side: "buy",
      orderType: "limit",
      amount: "75.5",
      price: "2",
      available: "150",
      symbol: "USDC",
    }),
    "Insufficient USDC balance.",
  );
});

test("rejects a market buy when its current-price estimate exceeds the quote balance", () => {
  assert.equal(
    validateOrderBalance({
      side: "buy",
      orderType: "market",
      amount: "4345252345234523",
      price: "1",
      available: "5547.391226",
      symbol: "USDC",
    }),
    "Insufficient USDC balance.",
  );
});
