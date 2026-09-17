import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hooksSource = readFileSync(new URL("./hooks.tsx", import.meta.url), "utf8");
const userOrdersSource =
  hooksSource.split("export function useUserOrders")[1]?.split("export function useOpenOrders")[0] ?? "";
const orderbookSource =
  hooksSource.split("export function useOrderbook")[1]?.split("export function useBestPrices")[0] ?? "";

test("refreshes orders from wallet-filtered placement and cancellation events", () => {
  assert.match(userOrdersSource, /eventName: "OrderPlaced",[\s\S]*?args: \{ poolId, trader: tradingAddress \}/);
  assert.match(userOrdersSource, /eventName: "OrderCancelled",[\s\S]*?args: \{ poolId, trader: tradingAddress \}/);
});

test("keeps existing orders visible during event refetches", () => {
  assert.match(userOrdersSource, /loadedRequestKey\.current !== requestKey/);
  assert.match(userOrdersSource, /if \(isInitialLoad\) setState\(\{ loading: true, error: null \}\)/);
  assert.match(userOrdersSource, /state\.loading \|\| \(loadedRequestKey\.current === null && pool\.loading\)/);
});

test("keeps the existing order book visible during event refetches", () => {
  assert.match(orderbookSource, /loadedRequestKey\.current !== requestKey/);
  assert.match(orderbookSource, /if \(isInitialLoad\) setState\(\{ loading: true, error: null \}\)/);
  assert.match(orderbookSource, /state\.loading \|\| \(loadedRequestKey\.current === null && pool\.loading\)/);
});
