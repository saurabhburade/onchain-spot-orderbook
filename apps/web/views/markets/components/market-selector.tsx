"use client";

import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import type { MarketListing, PoolId } from "@/lib/clob";

import { MarketPairIcon } from "./market-pair-icon";

function marketLabel(market: MarketListing) {
  return `${market.baseSymbol} / ${market.quoteSymbol}`;
}

function marketSpread(market: MarketListing) {
  if (!market.bestBid || !market.bestAsk) return "—";
  const bid = Number(market.bestBid);
  const ask = Number(market.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return "—";
  return `${(ask - bid).toFixed(market.quoteDecimals)} · ${(((ask - bid) / bid) * 100).toFixed(3)}%`;
}

type MarketSelectorProps = {
  currentBaseIconUrl?: string;
  currentPoolId: PoolId;
  currentQuoteIconUrl?: string;
  currentSymbol: string;
  loading: boolean;
  markets: MarketListing[];
  onSelect: (poolId: PoolId) => void;
};

export function MarketSelector({
  currentBaseIconUrl,
  currentPoolId,
  currentQuoteIconUrl,
  currentSymbol,
  loading,
  markets,
  onSelect,
}: MarketSelectorProps) {
  const resultsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuote, setActiveQuote] = useState("all");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const currentMarket = markets.find((market) => market.poolId.toLowerCase() === currentPoolId.toLowerCase());
  const baseIconUrl = currentMarket?.baseIconUrl ?? currentBaseIconUrl;
  const quoteIconUrl = currentMarket?.quoteIconUrl ?? currentQuoteIconUrl;
  const selectedMarketLabel = currentMarket ? marketLabel(currentMarket) : currentSymbol;
  const quoteSymbols = useMemo(() => [...new Set(markets.map((market) => market.quoteSymbol))].sort(), [markets]);
  const visibleMarkets = useMemo(() => {
    const search = query.trim().toLowerCase();
    return markets.filter((market) => {
      const matchesQuote = activeQuote === "all" || market.quoteSymbol === activeQuote;
      const matchesSearch =
        !search ||
        `${market.baseSymbol} ${market.quoteSymbol} ${market.poolId} ${market.clobAddress}`
          .toLowerCase()
          .includes(search);
      return matchesQuote && matchesSearch;
    });
  }, [activeQuote, markets, query]);

  const selectMarket = (market: MarketListing) => {
    setOpen(false);
    onSelect(market.poolId);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => (visibleMarkets.length ? (index + 1) % visibleMarkets.length : 0));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) =>
        visibleMarkets.length ? (index - 1 + visibleMarkets.length) % visibleMarkets.length : 0,
      );
    }
    if (event.key === "Enter" && visibleMarkets.length) {
      event.preventDefault();
      selectMarket(visibleMarkets[Math.min(highlightedIndex, visibleMarkets.length - 1)]);
    }
  };

  return (
    <Popover.Root
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) inputRef.current?.focus();
      }}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setQuery("");
          setActiveQuote("all");
          setHighlightedIndex(
            Math.max(
              0,
              markets.findIndex((market) => market.poolId === currentPoolId),
            ),
          );
        }
      }}
      open={open}
    >
      <Popover.Trigger className="group relative flex min-h-[4.25rem] w-full min-w-0 items-center justify-between gap-2 px-2.5 text-left outline-none transition-[background-color] duration-150 after:absolute after:-inset-y-0.5 after:inset-x-0 after:content-[''] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 group-data-popup-open:bg-muted">
        <span className="flex min-w-0 items-center gap-2">
          {currentMarket || baseIconUrl || quoteIconUrl ? (
            <MarketPairIcon
              baseIconUrl={baseIconUrl}
              baseSymbol={currentMarket?.baseSymbol ?? ""}
              compact
              quoteIconUrl={quoteIconUrl}
              quoteSymbol={currentMarket?.quoteSymbol ?? ""}
            />
          ) : null}
          <span className="truncate text-[13px] font-medium">{selectedMarketLabel}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-popup-open:rotate-180"
          strokeWidth={1.5}
        />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner align="start" className="z-50 max-w-[calc(100vw-1.5rem)]" side="bottom" sideOffset={8}>
          <Popover.Popup className="w-[min(44rem,calc(100vw-1.5rem))] origin-(--transform-origin) overflow-hidden rounded-xl bg-background text-foreground ring-1 ring-border transition-[opacity,scale,transform] duration-150 ease-out data-ending-style:-translate-y-1 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:-translate-y-1 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none">
            <Popover.Title className="sr-only">Select a market</Popover.Title>
            <Popover.Description className="sr-only">
              Search and select one of the listed spot markets.
            </Popover.Description>

            <div className="flex items-center gap-2 border-b border-border p-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  strokeWidth={1.5}
                />
                <input
                  aria-activedescendant={
                    visibleMarkets.length
                      ? `${resultsId}-${Math.min(highlightedIndex, visibleMarkets.length - 1)}`
                      : undefined
                  }
                  aria-autocomplete="list"
                  aria-controls={resultsId}
                  aria-expanded={open}
                  aria-label="Search listed markets"
                  className="h-10 w-full rounded-full bg-secondary/50 pr-3 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:bg-secondary/70"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlightedIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search market or address"
                  ref={inputRef}
                  role="combobox"
                  type="search"
                  value={query}
                />
              </div>
              <Popover.Close
                aria-label="Close market selector"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary/50 text-muted-foreground outline-none transition-[color,background-color,scale] duration-150 hover:bg-secondary/70 hover:text-foreground active:scale-[0.96] focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                <X aria-hidden="true" className="size-4" strokeWidth={1.5} />
              </Popover.Close>
            </div>

            <fieldset className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-border px-2">
              <legend className="sr-only">Filter by quote token</legend>
              {[
                { label: "All", value: "all" },
                ...quoteSymbols
                  .filter((symbol) => symbol !== "USDC")
                  .map((symbol) => ({ label: symbol, value: symbol })),
              ].map((filter) => {
                const selected = activeQuote === filter.value;
                return (
                  <button
                    aria-pressed={selected}
                    className={`relative h-10 shrink-0 px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30 ${selected ? "text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground"}`}
                    key={filter.value}
                    onClick={() => {
                      setActiveQuote(filter.value);
                      setHighlightedIndex(0);
                    }}
                    type="button"
                  >
                    {filter.label}
                  </button>
                );
              })}
            </fieldset>

            <div className="max-h-[min(52vh,22rem)] overflow-auto p-2">
              <div className="grid min-w-[640px] grid-cols-[minmax(11rem,1.35fr)_repeat(4,minmax(5.5rem,1fr))_2rem] px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <span>Market</span>
                <span className="text-right">Last price</span>
                <span className="text-right">Best bid</span>
                <span className="text-right">Best ask</span>
                <span className="text-right">Spread</span>
                <span />
              </div>

              {loading && markets.length === 0 ? (
                <div className="grid min-h-40 place-items-center text-sm text-muted-foreground">
                  Loading listed markets…
                </div>
              ) : null}
              {!loading && visibleMarkets.length === 0 ? (
                <div className="grid min-h-40 place-items-center px-5 text-center">
                  <div>
                    <p className="text-sm font-medium">No matching markets</p>
                    <p className="mt-1 text-pretty text-xs text-muted-foreground">
                      Try another token symbol or contract address.
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="min-w-[640px] space-y-0.5" id={resultsId} role="listbox">
                {visibleMarkets.map((market, index) => {
                  const selected = market.poolId === currentPoolId;
                  const highlighted = index === highlightedIndex;
                  return (
                    <button
                      aria-selected={selected}
                      className={`grid min-h-12 w-full grid-cols-[minmax(11rem,1.35fr)_repeat(4,minmax(5.5rem,1fr))_2rem] items-center rounded-lg px-2 text-left outline-none transition-colors ${highlighted ? "bg-muted" : "hover:bg-muted/60"} focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30`}
                      id={`${resultsId}-${index}`}
                      key={market.poolId}
                      onClick={() => selectMarket(market)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      role="option"
                      type="button"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <MarketPairIcon
                          baseIconUrl={market.baseIconUrl}
                          baseSymbol={market.baseSymbol}
                          compact
                          quoteIconUrl={market.quoteIconUrl}
                          quoteSymbol={market.quoteSymbol}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold">{marketLabel(market)}</span>
                          <span className="block text-[10px] text-chart-3">Spot</span>
                        </span>
                      </span>
                      <span className="text-right font-mono text-xs tabular-nums">
                        {market.lastPrice ?? market.bestAsk ?? market.bestBid ?? "—"}
                      </span>
                      <span className="text-right font-mono text-xs tabular-nums text-chart-3">
                        {market.bestBid ?? "—"}
                      </span>
                      <span className="text-right font-mono text-xs tabular-nums text-destructive">
                        {market.bestAsk ?? "—"}
                      </span>
                      <span className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                        {marketSpread(market)}
                      </span>
                      <span className="grid place-items-center text-chart-3">
                        {selected ? <Check aria-hidden="true" className="size-4" strokeWidth={2} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="hidden items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground sm:flex">
              <span>
                <kbd className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">↑↓</kbd>
                Navigate
              </span>
              <span>
                <kbd className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Enter</kbd>
                Select
              </span>
              <span>
                <kbd className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">Esc</kbd>
                Close
              </span>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
