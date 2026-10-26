import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";

import { PortfolioScreen } from "@/views/portfolio/components/portfolio-screen";

export const metadata: Metadata = { title: "Wallet portfolio | Orderbook" };

export default async function AddressPortfolioPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  return <PortfolioScreen account={getAddress(address)} />;
}
