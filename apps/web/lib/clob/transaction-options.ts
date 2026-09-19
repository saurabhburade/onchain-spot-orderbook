import { MONAD_TESTNET_CHAIN_ID } from "@/config/constants";

export function headlessTransactionOptions(address: string, chainId: number) {
  return {
    address,
    sponsor: chainId === MONAD_TESTNET_CHAIN_ID,
    uiOptions: { showWalletUIs: false as const },
  };
}
