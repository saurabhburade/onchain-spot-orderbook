import { redirect } from "next/navigation";

import { MONAD_TESTNET_CHAIN_ID } from "@/config/constants";

export default function PortfolioPage() {
  redirect(`/${MONAD_TESTNET_CHAIN_ID}/portfolio`);
}
