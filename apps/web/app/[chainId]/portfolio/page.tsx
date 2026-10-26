import type { Metadata } from "next";

import { PortfolioScreen } from "@/views/portfolio/components/portfolio-screen";

export const metadata: Metadata = { title: "Portfolio | Orderbook" };

export default function PortfolioPage() {
  return <PortfolioScreen />;
}
