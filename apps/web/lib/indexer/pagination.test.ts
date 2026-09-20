import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queriesSource = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
const tradePageSource = readFileSync(
  new URL("../../app/[chainId]/markets/[marketId]/trade/page.tsx", import.meta.url),
  "utf8",
);
const serverDataSource = readFileSync(new URL("./server-data.ts", import.meta.url), "utf8");
const tradingScreenSource = readFileSync(
  new URL("../../components/trading/trading-screen.tsx", import.meta.url),
  "utf8",
);
const accountPanelSource = readFileSync(new URL("../../components/trading/account-panel.tsx", import.meta.url), "utf8");

test("fetches each recent-trades page with a stable descending GraphQL window", () => {
  const recentTradesQuery =
    queriesSource.split("const recentTradesQuery = `")[1]?.split("const takerOrdersQuery")[0] ?? "";

  assert.match(recentTradesQuery, /query RecentTrades\(\$marketId: String!, \$limit: Int!, \$offset: Int!\)/);
  assert.match(recentTradesQuery, /order_by: \[\{ timestamp: desc \}, \{ blockNumber: desc \}, \{ logIndex: desc \}\]/);
  assert.match(recentTradesQuery, /limit: \$limit/);
  assert.match(recentTradesQuery, /offset: \$offset/);
  assert.doesNotMatch(recentTradesQuery, /limit: 50/);
  assert.match(queriesSource, /Market: \{ tradeCount: string \}\[\]/);
  assert.match(queriesSource, /offset: page \* pageSize/);
  assert.match(queriesSource, /totalCount: Number\(BigInt\(data\.Market\[0\]\?\.tradeCount \?\? "0"\)\)/);
});

test("renders each recent-trades page directly through the server component", () => {
  assert.match(tradePageSource, /recentTradesPage:\s*recentTradesPage\(query\.tradesPage\)/);
  assert.match(tradePageSource, /loadTradingIndexerSnapshot\(/);
  assert.match(serverDataSource, /fetchIndexedRecentTrades\(/);
  assert.match(tradingScreenSource, /search\.set\("tradesPage", String\(page\)\)/);
  assert.match(tradingScreenSource, /router\.replace\(/);
  assert.match(tradingScreenSource, /onRecentTradesPageChange=\{updateIndexerRoute\}/);
  assert.match(accountPanelSource, /recentTrades\.map\(\(trade\) =>/);
  assert.doesNotMatch(accountPanelSource, /recentTrades\.slice\(/);
  assert.match(accountPanelSource, /of \{recentTradesTotal\} trades/);
});

test("keeps recent-trades pagination stable while a server page is loading", () => {
  assert.match(accountPanelSource, /recentTradeSkeletonRows\.slice\(0, recentTradesPageSize\)/);
  assert.match(accountPanelSource, /trade-skeleton-10/);
  assert.match(accountPanelSource, /justify-end gap-3/);
  assert.ok((accountPanelSource.match(/size-8 rounded-xl/g) ?? []).length >= 2);
});
