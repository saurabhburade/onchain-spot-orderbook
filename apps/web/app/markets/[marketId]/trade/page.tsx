import { notFound, redirect } from "next/navigation";

type TradePageProps = {
  params: Promise<{ marketId: string }>;
};

export default async function TradePage({ params }: TradePageProps) {
  const { marketId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) notFound();
  redirect(`/10143/markets/${marketId}/trade`);
}
