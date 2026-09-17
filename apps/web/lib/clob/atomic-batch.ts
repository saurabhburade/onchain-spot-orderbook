import { type Address, encodeAbiParameters, encodeFunctionData, type Hex } from "viem";

const atomicBatchExecutorAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

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

// ERC-7579: batch call (0x01), revert on failure (0x00), no custom mode.
const REVERTING_BATCH_MODE = `0x01${"00".repeat(31)}` as Hex;

export type AtomicCall = {
  to: Address;
  data?: Hex;
  value?: bigint;
};

export function encodeAtomicBatch(calls: readonly AtomicCall[]): Hex {
  if (calls.length === 0) throw new Error("An atomic batch requires at least one call");
  const executionCalldata = encodeAbiParameters(executionTuple, [
    calls.map(({ to, data = "0x", value = 0n }) => ({ target: to, value, callData: data })),
  ]);
  return encodeFunctionData({
    abi: atomicBatchExecutorAbi,
    functionName: "execute",
    args: [REVERTING_BATCH_MODE, executionCalldata],
  });
}
