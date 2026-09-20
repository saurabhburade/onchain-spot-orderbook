"use client";

import { ArrowRight, Boxes, ChevronLeft, ChevronRight, Plus, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClobChain } from "@/lib/clob";
import type { MarketListing } from "@/lib/clob/types";
import { useRpcFirstMarkets } from "@/lib/indexer";

import { MarketPairIcon } from "./market-pair-icon";
import { getMarketPage, marketsPerPage } from "./pagination";

const marketSkeletons = ["market-a", "market-b", "market-c", "market-d", "market-e", "market-f"];
const skeletonColumns = ["price", "change", "volume", "book"];
const tableGrid = "grid-cols-[3rem_minmax(14rem,1.5fr)_repeat(3,minmax(8rem,1fr))_9rem]";

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatChange(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function MarketSkeleton() {
  return (
    <div
      aria-hidden="true"
      className={`grid ${tableGrid} min-w-[920px] animate-pulse items-center border-b border-border/70 px-4 py-4 motion-reduce:animate-none sm:px-6 lg:px-5 xl:px-6`}
    >
      <span className="h-3 w-4 rounded-full bg-muted" />
      <span className="h-9 w-36 rounded-full bg-muted" />
      {skeletonColumns.map((column) => (
        <span className="h-3 w-16 justify-self-end rounded-full bg-muted" key={column} />
      ))}
    </div>
  );
}

export function MarketsScreen({
  indexedMarkets,
  indexerError,
}: {
  indexedMarkets: MarketListing[];
  indexerError: string | null;
}) {
  const { chainId } = useClobChain();
  const router = useRouter();
  const [indexerRefreshing, startIndexerTransition] = useTransition();
  const refreshIndexer = useCallback(() => {
    startIndexerTransition(() => router.refresh());
  }, [router]);
  const markets = useRpcFirstMarkets(indexedMarkets, indexerError, refreshIndexer, indexerRefreshing);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const interval = window.setInterval(refreshIndexer, 15_000);
    return () => window.clearInterval(interval);
  }, [refreshIndexer]);
  const visibleMarkets = useMemo(() => {
    const search = query.trim().toLowerCase();
    return markets.data.filter((market) => {
      const matchesSearch =
        !search ||
        `${market.baseSymbol} ${market.quoteSymbol} ${market.poolId} ${market.clobAddress}`
          .toLowerCase()
          .includes(search);
      return matchesSearch;
    });
  }, [markets.data, query]);
  const marketPage = useMemo(() => getMarketPage(visibleMarkets, page), [page, visibleMarkets]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="w-full">
        <div className="flex flex-col gap-4 border-b-[0.5px] border-border px-4 py-4 sm:flex-row sm:items-center sm:px-6 lg:px-5 xl:px-6">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.5}
              />
              <Input
                aria-label="Search markets"
                className="h-8 rounded-full bg-muted/60 pr-3 pl-9 text-xs md:text-xs"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search markets"
                type="search"
                value={query}
              />
            </div>
            <Button
              aria-label="Refresh markets"
              className="rounded-full"
              disabled={markets.loading || indexerRefreshing}
              onClick={() => void markets.refetch()}
              size="icon"
              variant="outline"
            >
              <RefreshCw
                aria-hidden="true"
                className={markets.loading || indexerRefreshing ? "animate-spin motion-reduce:animate-none" : ""}
                strokeWidth={1.5}
              />
            </Button>
            <Button
              className="rounded-full text-xs"
              nativeButton={false}
              render={<Link href={`/${chainId}/markets/create`} />}
            >
              <Plus aria-hidden="true" data-icon="inline-start" strokeWidth={1.5} />
              Create market
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div
            className={`grid ${tableGrid} min-w-[920px] items-center border-b-[0.5px] border-border bg-muted/45 px-4 py-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:px-6 lg:px-5 xl:px-6`}
          >
            <span>#</span>
            <span>Market</span>
            <span className="text-right">Last price</span>
            <span className="text-right">24h change</span>
            <span className="text-right">24h volume</span>
            <span className="text-right">Book</span>
          </div>

          {markets.loading && markets.data.length === 0
            ? marketSkeletons.map((id) => <MarketSkeleton key={id} />)
            : null}

          {markets.error ? (
            <div className="grid min-h-48 place-items-center border-b border-border/70 px-6 py-10 text-center">
              <div>
                <p className="text-sm font-medium text-destructive">Could not load listed markets</p>
                <p className="mt-1 max-w-lg text-pretty text-xs text-muted-foreground">{markets.error.message}</p>
              </div>
            </div>
          ) : null}

          {!markets.loading && !markets.error && markets.data.length === 0 ? (
            <div className="grid min-h-48 place-items-center border-b border-border/70 px-6 py-10 text-center">
              <div>
                <Boxes aria-hidden="true" className="mx-auto size-7 text-muted-foreground" strokeWidth={1.5} />
                <p className="mt-3 text-sm font-medium">No listed markets</p>
                <p className="mt-1 text-pretty text-xs text-muted-foreground">
                  Markets will appear here after the factory creates its first pair.
                </p>
              </div>
            </div>
          ) : null}

          {!markets.loading && !markets.error && markets.data.length > 0 && visibleMarkets.length === 0 ? (
            <div className="grid min-h-48 place-items-center border-b border-border/70 px-6 py-10 text-center">
              <div>
                <Search aria-hidden="true" className="mx-auto size-7 text-muted-foreground" strokeWidth={1.5} />
                <p className="mt-3 text-sm font-medium">No matching markets</p>
                <p className="mt-1 text-pretty text-xs text-muted-foreground">
                  Try another pair, quote token, or contract address.
                </p>
              </div>
            </div>
          ) : null}

          {marketPage.items.map((market, index) => (
            <Link
              className={`group grid ${tableGrid} min-h-[72px] min-w-[920px] items-center border-b border-border/70 px-4 transition-colors duration-150 hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:outline-none sm:px-6 lg:px-5 xl:px-6`}
              href={`/${chainId}/markets/${market.poolId}/trade`}
              key={market.poolId}
            >
              <span className="text-sm tabular-nums text-muted-foreground">{marketPage.startIndex + index + 1}</span>
              <span className="flex min-w-0 items-center gap-3">
                <MarketPairIcon
                  baseIconUrl={market.baseIconUrl}
                  baseSymbol={market.baseSymbol}
                  quoteIconUrl={market.quoteIconUrl}
                  quoteSymbol={market.quoteSymbol}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">
                    {market.baseSymbol}/{market.quoteSymbol}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    Spot · {shortAddress(market.poolId)}
                  </span>
                </span>
              </span>
              <span className="text-right font-mono text-sm tabular-nums">
                {market.lastPrice ?? market.bestAsk ?? market.bestBid ?? "—"}
              </span>
              <span
                className={`text-right font-mono text-sm tabular-nums ${
                  market.change24h === null || market.change24h === undefined
                    ? "text-muted-foreground"
                    : market.change24h >= 0
                      ? "text-chart-3"
                      : "text-destructive"
                }`}
              >
                {formatChange(market.change24h)}
              </span>
              <span className="text-right font-mono text-sm tabular-nums text-muted-foreground">
                {market.volume24h === null || market.volume24h === undefined
                  ? "—"
                  : `${market.volume24h} ${market.quoteSymbol}`}
              </span>
              <span className="flex items-center justify-end gap-2 font-mono text-xs text-muted-foreground">
                {shortAddress(market.clobAddress)}
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 -translate-x-1 opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
                  strokeWidth={1.5}
                />
              </span>
            </Link>
          ))}
        </div>

        {!markets.loading && !markets.error && visibleMarkets.length > marketsPerPage ? (
          <nav
            aria-label="Markets pagination"
            className="flex min-h-14 items-center justify-center gap-1 border-b border-border px-4 py-2"
          >
            <Button
              aria-label="Go to previous markets page"
              className="size-9 rounded-full"
              disabled={marketPage.currentPage === 1}
              onClick={() => setPage(marketPage.currentPage - 1)}
              size="icon"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span
              aria-live="polite"
              className="min-w-24 text-center font-mono text-xs tabular-nums text-muted-foreground"
            >
              Page {marketPage.currentPage} of {marketPage.pageCount}
            </span>
            <Button
              aria-label="Go to next markets page"
              className="size-9 rounded-full"
              disabled={marketPage.currentPage === marketPage.pageCount}
              onClick={() => setPage(marketPage.currentPage + 1)}
              size="icon"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
      </main>
    </div>
  );
}
