"use client";

import Image from "next/image";

function TokenIcon({ url, symbol, className }: { url?: string; symbol: string; className: string }) {
  const fallback = symbol.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-semibold text-muted-foreground outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 ${className}`}
    >
      {fallback}
      {url ? (
        <Image
          alt=""
          className="object-cover"
          fill
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          sizes="32px"
          src={url}
        />
      ) : null}
    </span>
  );
}

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
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center ${compact ? "w-6" : "w-11"}`}>
      <TokenIcon className={iconSize} symbol={baseSymbol} url={baseIconUrl} />
      <span className={compact ? "-ml-1.5" : "-ml-2"}>
        <TokenIcon className={iconSize} symbol={quoteSymbol} url={quoteIconUrl} />
      </span>
    </span>
  );
}
