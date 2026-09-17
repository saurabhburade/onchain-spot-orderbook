import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AppHeader } from "@/components/app-header";
import { ChainRouteProviders } from "@/components/chain-route-providers";
import { isSupportedClobChainId } from "@/lib/clob/config";

export default async function ChainLayout({ children, params }: { children: ReactNode; params: Promise<unknown> }) {
  const resolvedParams = await params;
  if (!resolvedParams || typeof resolvedParams !== "object" || !("chainId" in resolvedParams)) notFound();
  const rawChainId = String(resolvedParams.chainId);
  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || !isSupportedClobChainId(chainId)) notFound();
  return (
    <ChainRouteProviders chainId={chainId}>
      <AppHeader active="markets" />
      {children}
    </ChainRouteProviders>
  );
}
