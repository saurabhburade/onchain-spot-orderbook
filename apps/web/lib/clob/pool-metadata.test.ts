import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { type Abi, decodeFunctionResult, encodeFunctionResult } from "viem";

const require = createRequire(import.meta.url);
const { poolRegistryAbi } = require("./abi.ts") as typeof import("./abi");
const { decodePoolResultData, normalizeRawPool } = require("./pool-metadata.ts") as typeof import("./pool-metadata");

const address = "0x0000000000000000000000000000000000000001";
const legacyPoolRegistryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "pool",
        type: "tuple",
        components: [
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "book", type: "address" },
          { name: "lotSize", type: "uint128" },
          { name: "tickSize", type: "uint128" },
          { name: "minTick", type: "uint24" },
          { name: "maxTick", type: "uint24" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const satisfies Abi;

describe("pool metadata normalization", () => {
  it("converts decoded uint24 tick indexes to bigint before price arithmetic", () => {
    const data = encodeFunctionResult({
      abi: poolRegistryAbi,
      functionName: "getPool",
      result: {
        baseAsset: address,
        quoteAsset: address,
        book: address,
        lotSize: 1_000_000n,
        tickSize: 1_000n,
        minTick: 1,
        maxTick: 1_000_000,
        tradingFeeBps: 10,
        baseDecimals: 18,
        quoteDecimals: 6,
        agnosticPricing: true,
        exists: true,
      },
    });
    const decoded = decodeFunctionResult({ abi: poolRegistryAbi, functionName: "getPool", data });

    assert.equal(typeof decoded.maxTick, "number");
    const pool = normalizeRawPool(decoded);
    assert.equal(typeof pool.maxTick, "bigint");
    assert.equal(pool.maxTick * pool.tickSize, 1_000_000_000n);
    assert.equal(pool.agnosticPricing, true);
    assert.equal(pool.tradingFeeBps, 10);
  });

  it("decodes the deployed legacy 8-field pool without reading past its 256-byte response", () => {
    const data = encodeFunctionResult({
      abi: legacyPoolRegistryAbi,
      functionName: "getPool",
      result: {
        baseAsset: address,
        quoteAsset: address,
        book: address,
        lotSize: 100_000n * 10n ** 18n,
        tickSize: 1n,
        minTick: 1,
        maxTick: 16_777_215,
        exists: true,
      },
    });

    assert.throws(() => decodeFunctionResult({ abi: poolRegistryAbi, functionName: "getPool", data }), /out of bounds/);
    const pool = decodePoolResultData(data);
    assert.equal(pool.lotSize, 100_000n * 10n ** 18n);
    assert.equal(pool.tradingFeeBps, 0);
    assert.equal(pool.agnosticPricing, false);
    assert.equal(pool.legacyFactory, true);
    assert.equal(pool.exists, true);
  });
});
