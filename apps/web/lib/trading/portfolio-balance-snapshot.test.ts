import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
  multicall3Abi,
  parseAbi,
  toHex,
} from "viem";
import { monadTestnet } from "viem/chains";

import type { readPortfolioBalanceSnapshot as SnapshotReader } from "../portfolio/balance-snapshot";

const require = createRequire(import.meta.url);
const { readPortfolioBalanceSnapshot } = require("../portfolio/balance-snapshot.ts") as {
  readPortfolioBalanceSnapshot: typeof SnapshotReader;
};
const account = `0x${"11".repeat(20)}` as const;
const token = `0x${"22".repeat(20)}` as const;
const book = `0x${"33".repeat(20)}` as const;
const escrowAbi = parseAbi([
  "function balanceOf(address account, address asset) view returns (uint256, uint256, uint256)",
]);
const contracts = [
  { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] },
  { address: book, abi: escrowAbi, functionName: "balanceOf", args: [account, token] },
] as const;

function movingChain() {
  let head = 100_000_000n;
  const requests: { method: string; block?: Hex }[] = [];
  const client = createPublicClient({
    chain: monadTestnet,
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_blockNumber") {
          requests.push({ method });
          return toHex(head++);
        }
        if (method === "eth_getBalance") {
          const [, block] = params as [string, Hex];
          requests.push({ method, block });
          return "0x5";
        }
        if (method === "eth_call") {
          const [{ data }, block] = params as [{ data: Hex }, Hex];
          requests.push({ method, block });
          const decoded = decodeFunctionData({ abi: multicall3Abi, data });
          assert.equal(decoded.functionName, "aggregate3");
          if (decoded.functionName !== "aggregate3") throw new Error("Expected aggregate3");
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: decoded.args[0].map((call) => ({
              success: true,
              returnData:
                call.target.toLowerCase() === token
                  ? encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 70n })
                  : encodeFunctionResult({ abi: escrowAbi, functionName: "balanceOf", result: [70n, 30n, 100n] }),
            })),
          });
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    }),
  });
  return { client, requests };
}

test("reads wallet and escrow together and selects a fresh block on the next poll", async () => {
  const { client, requests } = movingChain();
  const first = await readPortfolioBalanceSnapshot(client, account, contracts);
  assert.equal(first.native, 5n);
  assert.equal(first.results[0]?.status, "success");
  assert.equal(first.results[1]?.status, "success");
  if (first.results[0]?.status !== "success" || first.results[1]?.status !== "success") {
    throw new Error("Expected successful balance reads");
  }
  const wallet = first.results[0].result as bigint;
  const [, locked] = first.results[1].result as readonly [bigint, bigint, bigint];
  assert.equal(wallet + locked, 100n);
  assert.deepEqual(requests, [
    { method: "eth_blockNumber" },
    { method: "eth_getBalance", block: toHex(100_000_000n) },
    { method: "eth_call", block: toHex(100_000_000n) },
  ]);
  await readPortfolioBalanceSnapshot(client, account, contracts);
  assert.deepEqual(requests.slice(3), [
    { method: "eth_blockNumber" },
    { method: "eth_getBalance", block: toHex(100_000_001n) },
    { method: "eth_call", block: toHex(100_000_001n) },
  ]);
});

test("pins every RPC batch to one block when viem chunks a large multicall", async () => {
  const { client, requests } = movingChain();
  const manyContracts = Array.from({ length: 30 }, () => contracts).flat();
  const snapshot = await readPortfolioBalanceSnapshot(client, account, manyContracts);
  assert.equal(snapshot.results.length, manyContracts.length);
  assert.ok(requests.filter((request) => request.method === "eth_call").length > 1);
  assert.ok(requests.filter((request) => request.block).every((request) => request.block === toHex(100_000_000n)));
});

test("reads native balance without issuing an empty multicall", async () => {
  const { client, requests } = movingChain();
  const snapshot = await readPortfolioBalanceSnapshot(client, account, []);
  assert.equal(snapshot.native, 5n);
  assert.deepEqual(snapshot.results, []);
  assert.equal(requests.filter((request) => request.method === "eth_call").length, 0);
});
