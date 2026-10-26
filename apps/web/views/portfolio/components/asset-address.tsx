"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { ExternalLink } from "lucide-react";
import type { Address } from "viem";

export function AssetAddress({ address, explorer }: { address: Address; explorer?: string }) {
  const label = `${address.slice(0, 6)}…${address.slice(-4)}`;
  if (!explorer) return <span className="font-mono text-[11px] text-muted-foreground">{label}</span>;
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger
          aria-label={`View token ${address} on explorer`}
          className="inline-flex min-h-6 items-center gap-1 font-mono text-[11px] text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          render={<a href={`${explorer}/token/${address}`} rel="noreferrer" target="_blank" />}
        >
          {label}
          <ExternalLink aria-hidden="true" className="size-3" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner className="z-50" sideOffset={6}>
            <Tooltip.Popup className="rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm">
              View on explorer
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
