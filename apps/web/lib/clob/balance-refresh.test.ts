import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const walletButtonSource = readFileSync(new URL("../../components/wallet-button.tsx", import.meta.url), "utf8");
const accountHooksSource = readFileSync(new URL("../../hooks/clob/account-hooks.tsx", import.meta.url), "utf8");

test("broadcasts one balance refresh to all mounted consumers", () => {
  const { notifyBalanceRefresh, subscribeToBalanceRefresh } =
    require("./balance-refresh.ts") as typeof import("./balance-refresh");
  const previousWindow = globalThis.window;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget as typeof window;
  try {
    let walletRefreshes = 0;
    let tradeRefreshes = 0;
    const unsubscribeWallet = subscribeToBalanceRefresh(() => {
      walletRefreshes += 1;
    });
    const unsubscribeTrade = subscribeToBalanceRefresh(() => {
      tradeRefreshes += 1;
    });

    notifyBalanceRefresh();

    assert.equal(walletRefreshes, 1);
    assert.equal(tradeRefreshes, 1);
    unsubscribeWallet();
    notifyBalanceRefresh();
    assert.equal(walletRefreshes, 1);
    assert.equal(tradeRefreshes, 2);
    unsubscribeTrade();
  } finally {
    globalThis.window = previousWindow;
  }
});

test("wires the receipt signal into the wallet menu and trading balances", () => {
  assert.match(walletButtonSource, /subscribeToBalanceRefresh/);
  assert.match(walletButtonSource, /notifyBalanceRefresh/);
  assert.match(accountHooksSource, /subscribeToBalanceRefresh/);
});
