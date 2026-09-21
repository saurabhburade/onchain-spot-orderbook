"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactElement } from "react";

import { floatingMenuItemClassName, floatingMenuPopupClassName } from "@/components/ui/floating-menu-styles";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  clobNetworksByChainId,
  MONAD_TESTNET_CHAIN_ID,
  supportedClobNetworks,
  useClobChain,
  useClobWallet,
} from "@/lib/clob";

function MonadIcon() {
  return (
    <svg aria-hidden="true" className="pointer-events-none size-4 text-[#836EF9]" viewBox="0 0 24 24">
      <path
        d="M12 3c-2.599 0-9 6.4-9 9s6.401 9 9 9 9-6.401 9-9-6.401-9-9-9m-1.402 14.146c-1.097-.298-4.043-5.453-3.744-6.549s5.453-4.042 6.549-3.743c1.095.298 4.042 5.453 3.743 6.549-.298 1.095-5.453 4.042-6.549 3.743"
        fill="currentColor"
      />
    </svg>
  );
}

const CHAIN_METADATA_BY_ID: Readonly<Partial<Record<number, { icon: ReactElement }>>> = {
  [MONAD_TESTNET_CHAIN_ID]: { icon: <MonadIcon /> },
};

export function ChainSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const { chainId, config } = useClobChain();
  const { connected, switchToChain } = useClobWallet();

  const selectNetwork = async (targetChainId: number) => {
    const network = clobNetworksByChainId[targetChainId];
    if (!network || targetChainId === chainId) return;
    if (connected) await switchToChain(targetChainId);
    const targetRoot = `/${targetChainId}`;
    if (/^\/\d+\/markets\/0x[0-9a-f]{64}\/trade$/i.test(pathname)) {
      router.push(
        network.defaultPoolId ? `${targetRoot}/markets/${network.defaultPoolId}/trade` : `${targetRoot}/markets`,
      );
      return;
    }
    const segments = pathname.split("/");
    segments[1] = String(targetChainId);
    router.push(segments.join("/"));
  };

  return (
    <Select
      items={supportedClobNetworks.map((network) => ({ label: network.chain.name, value: network.chain.id }))}
      onValueChange={(targetChainId) => {
        if (targetChainId !== null) void selectNetwork(targetChainId);
      }}
      value={config.chain.id}
    >
      <SelectTrigger
        aria-label="Select network"
        className="h-8 shrink-0 bg-secondary px-3 py-0 text-xs text-secondary-foreground hover:bg-muted"
      >
        {CHAIN_METADATA_BY_ID[chainId]?.icon}
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className={`w-(--anchor-width) min-w-0 ${floatingMenuPopupClassName}`} sideOffset={8}>
        {supportedClobNetworks.map((network) => (
          <SelectItem
            className={`${floatingMenuItemClassName} py-0 pr-7 transition-none group-data-ending-style/select-popup:translate-y-0 group-data-ending-style/select-popup:opacity-100 group-data-ending-style/select-popup:blur-none group-data-starting-style/select-popup:translate-y-0 group-data-starting-style/select-popup:opacity-100 group-data-starting-style/select-popup:blur-none`}
            key={network.chain.id}
            value={network.chain.id}
          >
            {network.chain.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
