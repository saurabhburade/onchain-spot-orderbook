import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { ChainRouteProviders } from "@/components/chain-route-providers";
import { isSupportedClobChainId } from "@/config/chains";

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
      <AppFooter />
    </ChainRouteProviders>
  );
}
