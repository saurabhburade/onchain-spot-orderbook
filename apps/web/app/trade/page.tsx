import { redirect } from "next/navigation";
import { getClobNetwork } from "@/config/chains";
import { MONAD_TESTNET_CHAIN_ID } from "@/config/constants";
import { defaultTradePath } from "@/lib/trading/market-route";

export default function TradePage() {
  redirect(defaultTradePath(MONAD_TESTNET_CHAIN_ID, getClobNetwork(MONAD_TESTNET_CHAIN_ID).defaultPoolId));
}
