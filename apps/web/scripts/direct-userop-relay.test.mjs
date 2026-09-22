import assert from "node:assert/strict";
import test from "node:test";

import { decodeFunctionData, parseAbi } from "viem";

import { encodeKernelSingleCall, packUint128Pair, packUserOperation } from "./direct-userop-relay.mjs";

const kernelAbi = parseAbi(["function execute(bytes32 execMode,bytes executionCalldata) payable"]);

test("packs two uint128 UserOperation gas fields in network order", () => {
  assert.equal(packUint128Pair(1n, 2n), `0x${"0".repeat(31)}1${"0".repeat(31)}2`);
});

test("encodes a Kernel single-call execution without changing the caller identity", () => {
  const target = "0x1111111111111111111111111111111111111111";
  const data = "0x12345678";
  const encoded = encodeKernelSingleCall(target, data);
  const decoded = decodeFunctionData({ abi: kernelAbi, data: encoded });
  assert.equal(decoded.functionName, "execute");
  assert.equal(decoded.args[0], `0x${"0".repeat(64)}`);
  assert.equal(decoded.args[1], `${target}${"0".repeat(64)}${data.slice(2)}`);
});

test("packs an unpacked v0.7 UserOperation with no paymaster", () => {
  const packed = packUserOperation({
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 3n,
    callData: "0x1234",
    verificationGasLimit: 4n,
    callGasLimit: 5n,
    preVerificationGas: 6n,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 0n,
    signature: `0x${"11".repeat(65)}`,
  });
  assert.equal(packed.initCode, "0x");
  assert.equal(packed.paymasterAndData, "0x");
  assert.equal(packed.accountGasLimits, `0x${"0".repeat(31)}4${"0".repeat(31)}5`);
  assert.equal(packed.gasFees, `0x${"0".repeat(64)}`);
});
