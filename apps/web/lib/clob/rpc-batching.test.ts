import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const clientSource = readFileSync(new URL("../../config/viem.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../../config/chains.ts", import.meta.url), "utf8");
const hooksSource = readFileSync(new URL("../../hooks/use-clob.tsx", import.meta.url), "utf8");
const indexerHooksSource = readFileSync(new URL("../../hooks/use-indexer.ts", import.meta.url), "utf8");
const marketsScreenSource = readFileSync(
  new URL("../../components/markets/markets-screen.tsx", import.meta.url),
  "utf8",
);
const marketsPageSource = readFileSync(new URL("../../app/[chainId]/markets/page.tsx", import.meta.url), "utf8");
const indexerServerDataSource = readFileSync(new URL("../indexer/server-data.ts", import.meta.url), "utf8");
const faucetSource = readFileSync(new URL("../../components/token-tools/faucet-screen.tsx", import.meta.url), "utf8");

describe("Monad RPC request batching", () => {
  it("keeps contract event watchers off the HTTP read client", () => {
    assert.doesNotMatch(hooksSource, /publicClient\.watchContractEvent\(/);
    assert.match(hooksSource, /eventClient\.watchContractEvent\(/);
    assert.match(clientSource, /webSocket\(network\.wsRpcUrl,\s*\{/);
    assert.match(configSource, /wss:\/\/testnet-rpc\.monad\.xyz/);
  });

  it("keeps reconnecting event subscriptions and resyncs reads after socket errors", () => {
    assert.match(clientSource, /attempts:\s*EVENT_RECONNECT_ATTEMPTS/);
    assert.match(clientSource, /EVENT_RECONNECT_ATTEMPTS\s*=\s*Number\.MAX_SAFE_INTEGER/);
    assert.match(clientSource, /delay:\s*EVENT_RECONNECT_DELAY_MS/);
    assert.match(hooksSource, /onError:\s*\(\)\s*=>\s*void refetch\(\)/);
    assert.doesNotMatch(
      hooksSource,
      /onError:\s*\(error\)\s*=>\s*setState\(\{\s*loading:\s*false,\s*error:\s*toError\(error\)\s*\}\)/,
    );
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

  it("discovers listed markets from the factory RPC before falling back to the indexer", () => {
    assert.match(hooksSource, /functionName:\s*"allPairsLength"/);
    assert.match(hooksSource, /functionName:\s*"pairAt"/);
    assert.match(indexerHooksSource, /export function useRpcFirstMarkets/);
    assert.match(indexerHooksSource, /if \(rpc\.data\.length === 0\) return indexedMarkets/);
    assert.match(marketsScreenSource, /useRpcFirstMarkets\(indexedMarkets, indexerError/);
    assert.match(marketsPageSource, /loadIndexedMarketListings\(chainId\)/);
  });

  it("reuses RPC snapshots and refreshes server-rendered indexer listings", () => {
    const useMarketsSource =
      hooksSource.split("export function useMarkets()")[1]?.split("export function useCreateMarket")[0] ?? "";

    assert.match(useMarketsSource, /marketSnapshotCache\(publicClient\)\.get\(snapshotKey\)/);
    assert.match(useMarketsSource, /marketSnapshotCache\(publicClient\)\.set\(snapshotKey, markets\)/);
    assert.match(useMarketsSource, /if \(!marketSnapshotCache\(publicClient\)\.has\(snapshotKey\)\) void refetch\(\)/);
    assert.match(indexerServerDataSource, /fetchIndexedMarketListings\(chainId\)/);
    assert.match(marketsScreenSource, /router\.refresh\(\)/);
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
