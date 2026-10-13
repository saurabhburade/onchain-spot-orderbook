import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const accountPanelSource = readFileSync(
  new URL("../../views/trading/components/account-panel.tsx", import.meta.url),
  "utf8",
);
const transactionHooksSource = readFileSync(new URL("../../hooks/clob/transaction-hooks.tsx", import.meta.url), "utf8");

test("offers owner-directed recovery for quarantined orders", () => {
  assert.match(accountPanelSource, /order\.status === "quarantined"/);
  assert.match(accountPanelSource, /Recover quarantined escrow/);
  assert.match(accountPanelSource, /onCloseQuarantined\(orderId, recoveryReceiver\)/);
  assert.match(transactionHooksSource, /functionName: "closeQuarantinedOrder"/);
  assert.match(transactionHooksSource, /args: \[orderId, receiver\]/);
});
