import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { sanitizeDecimalInput, sanitizeIntegerInput } =
  require("./numeric-input.ts") as typeof import("./numeric-input");

test("decimal input removes non-numeric text", () => {
  assert.equal(sanitizeDecimalInput("fgsdfgsdfg"), "");
  assert.equal(sanitizeDecimalInput("12abc.34xyz"), "12.34");
  assert.equal(sanitizeDecimalInput("1e3"), "13");
  assert.equal(sanitizeDecimalInput(" - 42.5 "), "42.5");
});

test("decimal input preserves normal in-progress editing states", () => {
  assert.equal(sanitizeDecimalInput(""), "");
  assert.equal(sanitizeDecimalInput(".5"), ".5");
  assert.equal(sanitizeDecimalInput("5."), "5.");
  assert.equal(sanitizeDecimalInput("0005.00"), "0005.00");
  assert.equal(sanitizeDecimalInput("1.2.3"), "1.23");
});

test("integer input keeps digits only", () => {
  assert.equal(sanitizeIntegerInput("fgsdfgsdfg"), "");
  assert.equal(sanitizeIntegerInput("18abc"), "18");
  assert.equal(sanitizeIntegerInput("1.8"), "18");
  assert.equal(sanitizeIntegerInput(" -255 "), "255");
  assert.equal(sanitizeIntegerInput(""), "");
  assert.equal(sanitizeIntegerInput("0018"), "0018");
});
