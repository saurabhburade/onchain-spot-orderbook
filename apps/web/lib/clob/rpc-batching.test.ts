import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const clientSource = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
const hooksSource = readFileSync(new URL("./hooks.tsx", import.meta.url), "utf8");
const faucetSource = readFileSync(new URL("../../components/token-tools/faucet-screen.tsx", import.meta.url), "utf8");

describe("Monad RPC request batching", () => {
  it("keeps contract event watchers off the HTTP read client", () => {
    assert.doesNotMatch(hooksSource, /publicClient\.watchContractEvent\(/);
    assert.match(hooksSource, /eventClient\.watchContractEvent\(/);
    assert.match(clientSource, /webSocket\(network\.wsRpcUrl\)/);
    assert.match(configSource, /wss:\/\/testnet-rpc\.monad\.xyz/);
  });

  it("enables viem transport multicall batching", () => {
    assert.match(clientSource, /batch:\s*\{\s*multicall:\s*true\s*\}/);
  });

  it("enables HTTP JSON-RPC batching", () => {
    assert.match(clientSource, /network\.rpcEndpoints\.map/);
    assert.match(clientSource, /batch:\s*endpoint\.batch/);
  });

  it("fails over across official Monad RPC endpoints", () => {
    assert.match(clientSource, /fallback\(transports,\s*\{\s*retryCount:\s*0\s*\}\)/);
    assert.match(configSource, /https:\/\/testnet-rpc\.monad\.xyz/);
    assert.match(configSource, /https:\/\/rpc\.ankr\.com\/monad_testnet/);
    assert.match(configSource, /https:\/\/rpc-testnet\.monadinfra\.com/);
    assert.match(configSource, /NEXT_PUBLIC_MONAD_RPC_URLS/);
  });

  it("uses Monadscan for transaction links", () => {
    assert.match(configSource, /https:\/\/testnet\.monadscan\.com/);
  });

  it("coalesces immutable pool metadata reads", () => {
    assert.match(hooksSource, /poolMetadataCache/);
    assert.match(hooksSource, /cachedReadPoolMetadata/);
  });

  it("uses explicit multicalls for grouped contract reads", () => {
    assert.ok((hooksSource.match(/publicClient\.multicall\(/g) ?? []).length >= 4);
    assert.match(faucetSource, /publicClient\.multicall\(/);
  });

  it("reads user orders with eth_call instead of historical event filters", () => {
    const start = hooksSource.indexOf("export function useUserOrders");
    const end = hooksSource.indexOf("function transactionError", start);
    const userOrdersSource = hooksSource.slice(start, end);

    assert.match(userOrdersSource, /functionName:\s*"getUserOrders"/);
    assert.match(userOrdersSource, /functionName:\s*"getUserOrderIds"/);
    assert.doesNotMatch(userOrdersSource, /getLogsInBlockRanges|publicClient\.getLogs/);
  });
});
