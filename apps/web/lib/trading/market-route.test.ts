import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { missingMarketRecoveryPath } = require("./market-route.ts") as typeof import("./market-route");

const stalePool = `0x${"11".repeat(32)}` as const;
const defaultPool = `0x${"22".repeat(32)}` as const;

test("redirects a confirmed missing pool to the current deployment default", () => {
  assert.equal(
    missingMarketRecoveryPath({
      chainId: 10143,
      currentPoolId: stalePool,
      defaultPoolId: defaultPool,
      errorMessage: `Pool ${stalePool} does not exist`,
    }),
    `/10143/markets/${defaultPool}/trade`,
  );
});

test("does not redirect transient or unrelated failures", () => {
  assert.equal(
    missingMarketRecoveryPath({
      chainId: 10143,
      currentPoolId: stalePool,
      defaultPoolId: defaultPool,
      errorMessage: "RPC request failed",
    }),
    null,
  );
});

test("falls back to the market list instead of redirecting in a loop", () => {
  assert.equal(
    missingMarketRecoveryPath({
      chainId: 10143,
      currentPoolId: defaultPool,
      defaultPoolId: defaultPool,
      errorMessage: `Pool ${defaultPool} does not exist`,
    }),
    "/10143/markets",
  );
});
