import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const webRoot = new URL("../../", import.meta.url);
const hooksSource = readFileSync(new URL("hooks/use-indexer.ts", webRoot), "utf8");
const marketsPageSource = readFileSync(new URL("app/[chainId]/markets/page.tsx", webRoot), "utf8");
const tradePageSource = readFileSync(new URL("app/[chainId]/markets/[marketId]/trade/page.tsx", webRoot), "utf8");
const marketsScreenSource = readFileSync(new URL("views/markets/components/markets-screen.tsx", webRoot), "utf8");
const tradingScreenSource = readFileSync(new URL("views/trading/components/trading-screen.tsx", webRoot), "utf8");
const chainsSource = readFileSync(new URL("config/chains.ts", webRoot), "utf8");
const graphqlClientSource = readFileSync(new URL("lib/indexer/client.ts", webRoot), "utf8");
const graphqlQueriesSource = readFileSync(new URL("lib/indexer/queries.ts", webRoot), "utf8");
const serverDataSource = readFileSync(new URL("lib/indexer/server-data.ts", webRoot), "utf8");
const recentTradesActionSource = readFileSync(new URL("lib/indexer/recent-trades-action.ts", webRoot), "utf8");

test("fetches indexer data directly in server-rendered route pages", () => {
  assert.match(marketsPageSource, /loadIndexedMarketListings\(chainId\)/);
  assert.match(tradePageSource, /loadTradingIndexerSnapshot\(/);
  assert.match(serverDataSource, /^import "server-only";/);
  assert.match(serverDataSource, /fetchIndexedMarkets\(getIndexerGraphqlUrl\(chainId\)\)/);
  assert.match(serverDataSource, /fetchIndexedMarketDetail\(endpoint, input\.marketId\)/);
  assert.match(serverDataSource, /fetchIndexedRecentTrades\(/);
  assert.doesNotMatch(serverDataSource, /fetchIndexedOrderHistory\(/);
});

test("keeps GraphQL and indexer endpoints out of the client module graph", () => {
  const clientSources = [hooksSource, marketsScreenSource, tradingScreenSource].join("\n");
  assert.doesNotMatch(clientSources, /fetchIndexed|ENVIO_GRAPHQL_URL|v1\/graphql|\/api\/indexer/);
  assert.doesNotMatch(chainsSource, /indexerGraphqlUrl|ENVIO_GRAPHQL_URL/);
  assert.match(graphqlClientSource, /^import "server-only";/);
  assert.match(graphqlQueriesSource, /^import "server-only";/);
  assert.equal(existsSync(new URL("app/api/indexer/[chainId]/[resource]/route.ts", webRoot)), false);
});

test("polls recent trades without refreshing the trading route or exposing an indexer proxy", () => {
  assert.match(marketsScreenSource, /router\.refresh\(\)/);
  assert.doesNotMatch(tradingScreenSource, /router\.refresh\(\)/);
  assert.match(tradingScreenSource, /refreshIndexedRecentTrades/);
  assert.match(tradingScreenSource, /refetchInterval:\s*1_000/);
  assert.match(recentTradesActionSource, /^"use server";/);
  assert.match(recentTradesActionSource, /fetchIndexedRecentTrades\(/);
  assert.match(recentTradesActionSource, /isSupportedClobChainId/);
  assert.match(tradingScreenSource, /router\.replace\(/);
});

test("keeps connected-account order history on wallet-scoped client RPC reads", () => {
  assert.match(tradingScreenSource, /clob\.orderHistory\.data\.map\(mapHistoryOrder\)/);
  assert.match(tradingScreenSource, /orderHistoryError=\{clob\.orderHistory\.error\?\.message/);
  assert.match(tradingScreenSource, /orderHistoryLoading=\{clob\.orderHistory\.loading\}/);
  assert.doesNotMatch(serverDataSource, /fetchIndexedOrderHistory/);
  assert.doesNotMatch(tradePageSource, /query\.trader|trader,/);
});
