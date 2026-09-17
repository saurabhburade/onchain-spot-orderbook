import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { type Address, decodeAbiParameters, decodeFunctionData, type Hex, parseAbi } from "viem";

const require = createRequire(import.meta.url);
const { encodeAtomicBatch } = require("./atomic-batch.ts") as typeof import("./atomic-batch");

const executorAbi = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);
const executionTuple = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

describe("ERC-7579 atomic order batches", () => {
  it("encodes an all-or-nothing batch with calls in their original order", () => {
    const calls = [
      { to: "0x0000000000000000000000000000000000000001" as Address, data: "0xaaaa" as Hex },
      { to: "0x0000000000000000000000000000000000000002" as Address, data: "0xbbbb" as Hex },
      { to: "0x0000000000000000000000000000000000000001" as Address, data: "0xcccc" as Hex },
    ];

    const decoded = decodeFunctionData({ abi: executorAbi, data: encodeAtomicBatch(calls) });
    assert.equal(decoded.functionName, "execute");
    assert.equal(decoded.args[0], `0x01${"00".repeat(31)}`);

    const [executions] = decodeAbiParameters(executionTuple, decoded.args[1]);
    assert.deepEqual(
      executions.map(({ target, value, callData }) => ({ target, value, callData })),
      calls.map(({ to, data }) => ({ target: to, value: 0n, callData: data })),
    );
  });

  it("rejects an empty batch", () => {
    assert.throws(() => encodeAtomicBatch([]), /at least one call/i);
  });
});
