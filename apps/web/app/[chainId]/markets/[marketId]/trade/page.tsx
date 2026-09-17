import { notFound } from "next/navigation";

import { TradingScreen } from "@/components/trading/trading-screen";
import type { PoolId } from "@/lib/clob";

export default async function TradePage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) notFound();
  return <TradingScreen marketId={marketId as PoolId} />;
}
