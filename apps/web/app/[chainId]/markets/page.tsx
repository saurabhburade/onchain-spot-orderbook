import { notFound } from "next/navigation";
import { isSupportedClobChainId } from "@/config/chains";
import { loadIndexedMarketListings } from "@/lib/indexer/server-data";
import { MarketsScreen } from "@/views/markets/components/markets-screen";

export const dynamic = "force-dynamic";

export default async function MarketsPage({ params }: { params: Promise<{ chainId: string }> }) {
  const chainId = Number((await params).chainId);
  if (!Number.isSafeInteger(chainId) || !isSupportedClobChainId(chainId)) notFound();
  const indexed = await loadIndexedMarketListings(chainId);
  return <MarketsScreen indexedMarkets={indexed.data} indexerError={indexed.error} />;
}
