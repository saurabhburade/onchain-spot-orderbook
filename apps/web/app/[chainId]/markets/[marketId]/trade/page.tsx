import { notFound } from "next/navigation";

import { TradingScreen } from "@/components/trading/trading-screen";
import { isSupportedClobChainId } from "@/config/chains";
import type { PoolId } from "@/lib/clob";
import { loadTradingIndexerSnapshot } from "@/lib/indexer/server-data";

const recentTradesPageSize = 10;
const maxRecentTradesOffset = 10_000;

function recentTradesPage(value: string | string[] | undefined) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0;
  const page = Number(value);
  return Number.isSafeInteger(page) && page * recentTradesPageSize <= maxRecentTradesOffset ? page : 0;
}

export const dynamic = "force-dynamic";

export default async function TradePage({
  params,
  searchParams,
}: {
  params: Promise<{ chainId: string; marketId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ chainId: rawChainId, marketId }, query] = await Promise.all([params, searchParams]);
  const chainId = Number(rawChainId);
  if (!Number.isSafeInteger(chainId) || !isSupportedClobChainId(chainId)) notFound();
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) notFound();
  const indexer = await loadTradingIndexerSnapshot({
    chainId,
    marketId: marketId as PoolId,
    recentTradesPage: recentTradesPage(query.tradesPage),
    recentTradesPageSize,
  });
  return <TradingScreen indexer={indexer} marketId={marketId as PoolId} />;
}
