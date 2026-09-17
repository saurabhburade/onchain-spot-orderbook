import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { deriveAllocationPercentage } =
  require("./trade-ticket-allocation.ts") as typeof import("./trade-ticket-allocation");

test("derives buy allocation from size, price, and quote balance", () => {
  assert.equal(deriveAllocationPercentage({ amount: "50.5", available: "400", isBuy: true, price: "2" }), 25.25);
});

test("derives sell allocation directly from base balance", () => {
  assert.equal(deriveAllocationPercentage({ amount: "30", available: "120", isBuy: false, price: "" }), 25);
});

test("caps over-balance entries at the slider endpoint", () => {
  assert.equal(
    deriveAllocationPercentage({ amount: "122222", available: "13442.763355", isBuy: true, price: "0.15" }),
    100,
  );
});

test("treats incomplete or invalid values as zero allocation", () => {
  assert.equal(deriveAllocationPercentage({ amount: "", available: "120", isBuy: false, price: "" }), 0);
  assert.equal(deriveAllocationPercentage({ amount: "20", available: "0", isBuy: false, price: "" }), 0);
  assert.equal(deriveAllocationPercentage({ amount: "20", available: "120", isBuy: true, price: "nope" }), 0);
});
