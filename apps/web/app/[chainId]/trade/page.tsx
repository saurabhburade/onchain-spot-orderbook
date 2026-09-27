import { notFound, redirect } from "next/navigation";
import { getClobNetwork, isSupportedClobChainId } from "@/config/chains";
import { defaultTradePath } from "@/lib/trading/market-route";

export default async function TradePage({ params }: { params: Promise<{ chainId: string }> }) {
  const { chainId: rawChainId } = await params;
  const chainId = Number(rawChainId);
  if (!Number.isSafeInteger(chainId) || !isSupportedClobChainId(chainId)) notFound();
  redirect(defaultTradePath(chainId, getClobNetwork(chainId).defaultPoolId));
}
