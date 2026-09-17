import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { type Address, ContractFunctionRevertedError, encodeFunctionData, toFunctionSelector } from "viem";

const require = createRequire(import.meta.url);
const { poolRegistryAbi } = require("./abi.ts") as typeof import("./abi");
const {
  AGNOSTIC_CREATE_PAIR_SELECTOR,
  LEGACY_CREATE_PAIR_SELECTOR,
  defaultMarketLotSize,
  hasFunctionSelector,
  isUnsupportedContractFunctionError,
  legacyCreatePairArgs,
  legacyLotConfiguration,
  lowPriceLotSize,
} = require("./factory-compat.ts") as typeof import("./factory-compat");

const baseAsset = "0x0000000000000000000000000000000000000001" as Address;
const quoteAsset = "0x0000000000000000000000000000000000000002" as Address;

describe("factory compatibility", () => {
  it("encodes the supply-agnostic factory signature", () => {
    const data = encodeFunctionData({
      abi: poolRegistryAbi,
      functionName: "createPair",
      args: [baseAsset, quoteAsset],
    });
    assert.equal(data.slice(0, 10), toFunctionSelector("createPair(address,address)"));
  });

  it("selects the deployed legacy createPair overload when agnostic pricing is unavailable", () => {
    const legacyBytecode = `0x6000${LEGACY_CREATE_PAIR_SELECTOR.slice(2)}00` as `0x${string}`;
    assert.equal(hasFunctionSelector(legacyBytecode, AGNOSTIC_CREATE_PAIR_SELECTOR), false);
    assert.equal(hasFunctionSelector(legacyBytecode, LEGACY_CREATE_PAIR_SELECTOR), true);
    const data = encodeFunctionData({
      abi: poolRegistryAbi,
      functionName: "createPair",
      args: legacyCreatePairArgs(baseAsset, quoteAsset),
    });
    assert.equal(data.slice(0, 10), toFunctionSelector("createPair(address,address,uint128,uint24,uint24)"));
  });

  it("falls back only for empty-data absent-function reverts", () => {
    assert.equal(
      isUnsupportedContractFunctionError(
        new ContractFunctionRevertedError({ abi: [], data: "0x", functionName: "marketCreationFee" }),
      ),
      true,
    );
    assert.equal(
      isUnsupportedContractFunctionError(
        new ContractFunctionRevertedError({ abi: [], data: "0xdeadbeef", functionName: "marketCreationFee" }),
      ),
      false,
    );
    assert.equal(isUnsupportedContractFunctionError(new Error("RPC unavailable")), false);
  });

  it("derives the legacy lot size from eight tradable decimals", () => {
    assert.deepEqual(legacyLotConfiguration(18), { lotDecimals: 8, lotSize: 10_000_000_000n });
    assert.deepEqual(legacyLotConfiguration(6), { lotDecimals: 6, lotSize: 1n });
  });

  it("derives a 100,000-token lot for low-price markets", () => {
    assert.equal(lowPriceLotSize(18), 100_000n * 10n ** 18n);
    assert.equal(lowPriceLotSize(6), 100_000n * 10n ** 6n);
    assert.throws(() => lowPriceLotSize(34), /too large/);
  });

  it("derives one automatic whole-token lot", () => {
    assert.equal(defaultMarketLotSize(18), 10n ** 18n);
    assert.equal(defaultMarketLotSize(6), 10n ** 6n);
    assert.throws(() => defaultMarketLotSize(39), /too large/);
  });

  it("encodes the managed-lot factory signature when lotSize is omitted", () => {
    const data = encodeFunctionData({
      abi: poolRegistryAbi,
      functionName: "createPair",
      args: [baseAsset, quoteAsset, 1n, 1, 100],
    });
    assert.equal(data.slice(0, 10), toFunctionSelector("createPair(address,address,uint128,uint24,uint24)"));
  });

  it("encodes the legacy factory signature when lotSize is supplied", () => {
    const data = encodeFunctionData({
      abi: poolRegistryAbi,
      functionName: "createPair",
      args: [baseAsset, quoteAsset, 10_000_000_000n, 1n, 1, 100],
    });
    assert.equal(data.slice(0, 10), toFunctionSelector("createPair(address,address,uint128,uint128,uint24,uint24)"));
  });
});
