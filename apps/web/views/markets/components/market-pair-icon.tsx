"use client";

import { TokenIcon } from "@/components/token-icon";

export function MarketPairIcon({
  baseIconUrl,
  baseSymbol,
  quoteIconUrl,
  quoteSymbol,
  compact = false,
}: {
  baseSymbol: string;
  quoteSymbol: string;
  baseIconUrl?: string;
  quoteIconUrl?: string;
  compact?: boolean;
}) {
  const iconSize = compact ? "size-[18px]" : "size-8";
  const fallbackSize = compact ? "size-3" : "size-4";
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center ${compact ? "w-8" : "w-14"}`}>
      <TokenIcon
        alt={`${baseSymbol} token icon`}
        className={`bg-muted ${iconSize}`}
        fallbackClassName={fallbackSize}
        sizes="32px"
        url={baseIconUrl}
      />
      <span className={compact ? "-ml-1.5" : "-ml-2"}>
        <TokenIcon
          alt={`${quoteSymbol} token icon`}
          className={`bg-muted ${iconSize}`}
          fallbackClassName={fallbackSize}
          sizes="32px"
          url={quoteIconUrl}
        />
      </span>
    </span>
  );
}
