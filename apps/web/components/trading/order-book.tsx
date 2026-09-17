"use client";

import { ArrowDown, ArrowUp, Layers3 } from "lucide-react";
import { useEffect, useRef } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BestPrices } from "@/lib/clob";
import { cn } from "@/lib/utils";

import type { OrderBookLevel } from "./market-data";

const skeletonRows = [38, 68, 52, 84, 61, 74, 46];

function spreadText(bid: string, ask: string) {
  const bidValue = Number.parseFloat(bid);
  const askValue = Number.parseFloat(ask);
  if (!Number.isFinite(bidValue) || !Number.isFinite(askValue) || bidValue <= 0 || askValue < bidValue) return "—";
  return `${(askValue - bidValue).toFixed(6)} (${(((askValue - bidValue) / bidValue) * 100).toFixed(3)}%)`;
}

function LevelRows({
  levels,
  side,
  onSelectLevel,
}: {
  levels: OrderBookLevel[];
  side: "ask" | "bid";
  onSelectLevel?: (level: OrderBookLevel) => void;
}) {
  return (
    <TableBody>
      {levels.map((level) => (
        <TableRow
          className="relative h-8 cursor-pointer border-border hover:bg-muted/35"
          key={`${side}-${level.price}`}
          onClick={() => onSelectLevel?.(level)}
          style={{
            backgroundImage: `linear-gradient(to ${side === "ask" ? "left" : "right"}, color-mix(in oklch, var(${side === "ask" ? "--destructive" : "--chart-3"}) 8%, transparent) ${level.depth}%, transparent ${level.depth}%)`,
          }}
        >
          <TableCell
            className={cn(
              "h-8 py-0 font-mono text-xs tabular-nums",
              side === "ask" ? "text-destructive" : "text-chart-3",
            )}
          >
            <button
              aria-label={`Use price ${level.price} and size ${level.size} for a limit order`}
              className="h-8 w-full cursor-pointer text-left font-mono transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              type="button"
            >
              {level.price}
            </button>
          </TableCell>
          <TableCell className="h-8 py-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
            {level.size}
          </TableCell>
          <TableCell className="h-8 py-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
            {level.total}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  );
}

function LevelRowsSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
      {skeletonRows.map((width) => (
        <div className="grid h-8 grid-cols-3 items-center gap-3 border-b border-border px-2" key={width}>
          <span className="h-2 w-12 rounded-full bg-muted" />
          <span className="ml-auto h-2 w-8 rounded-full bg-muted" />
          <span className="ml-auto h-2 rounded-full bg-muted" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

export function OrderBook({
  orderbook,
  bestPrices,
  baseSymbol = "BASE",
  quoteSymbol = "QUOTE",
  depth = 50,
  loading,
  error,
  onSelectLevel,
}: {
  orderbook: { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null;
  bestPrices: BestPrices | null;
  baseSymbol?: string;
  quoteSymbol?: string;
  depth?: number;
  loading?: boolean;
  error?: string | null;
  onSelectLevel?: (level: OrderBookLevel) => void;
}) {
  const askViewportRef = useRef<HTMLDivElement>(null);
  const positionedInitialAsks = useRef(false);
  const asks = orderbook?.asks ?? [];
  const bids = orderbook?.bids ?? [];
  const displayAsks = asks.toReversed();
  const bestBid = bestPrices?.bid?.price ?? bids[0]?.price ?? null;
  const bestAsk = bestPrices?.ask?.price ?? asks[0]?.price ?? null;
  const spread = bestBid && bestAsk ? spreadText(bestBid, bestAsk) : "—";
  const pending = Boolean(loading && !orderbook);
  const empty = Boolean(!loading && !error && !asks.length && !bids.length);

  useEffect(() => {
    if (!asks.length || positionedInitialAsks.current) return;
    const frame = requestAnimationFrame(() => {
      const viewport = askViewportRef.current;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        positionedInitialAsks.current = true;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [asks.length]);

  return (
    <Card className="flex min-w-0 flex-col gap-0 py-0 ring-[0.5px] ring-border dark:ring-border lg:col-start-2 lg:row-start-2 lg:h-full lg:rounded-none lg:bg-background lg:ring-0 xl:row-span-2 xl:row-start-1">
      <CardHeader className="!flex h-[4.25rem] !items-center border-b border-border px-3 py-0 !pb-0">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="shrink-0 text-sm font-semibold tracking-tight text-foreground">Order book</h2>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <ArrowUp aria-hidden="true" className="size-3 text-destructive" />
                Asks
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowDown aria-hidden="true" className="size-3 text-chart-3" />
                Bids
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <Layers3 aria-hidden="true" className="size-3.5" />
            <span className="font-mono text-[10px]">{depth} / side</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-0 sm:px-3">
        <Table className="shrink-0 table-fixed">
          <TableHeader>
            <TableRow className="border-0 hover:bg-transparent">
              <TableHead className="h-6 px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Price ({quoteSymbol})
              </TableHead>
              <TableHead className="h-6 px-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                Size ({baseSymbol})
              </TableHead>
              <TableHead className="h-6 px-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                Total
              </TableHead>
            </TableRow>
          </TableHeader>
        </Table>
        <div className="h-56 min-h-0 flex-none overflow-y-auto overscroll-contain" ref={askViewportRef}>
          <div className="flex min-h-full flex-col justify-end">
            {pending ? <LevelRowsSkeleton /> : null}
            {error ? (
              <p className="grid h-56 place-items-center px-4 text-center text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {empty ? (
              <p className="grid h-56 place-items-center px-4 text-center text-xs text-muted-foreground">
                No resting orders in this market.
              </p>
            ) : null}
            {!pending && !error && !empty ? (
              <Table className="shrink-0 table-fixed">
                <LevelRows levels={displayAsks} side="ask" onSelectLevel={onSelectLevel} />
              </Table>
            ) : null}
          </div>
        </div>
        <div className="my-1 flex items-center justify-between rounded-lg bg-muted/55 px-2.5 py-1.5">
          {pending ? (
            <>
              <span className="h-3.5 w-10 animate-pulse rounded-full bg-background/80 motion-reduce:animate-none" />
              <span className="h-2.5 w-24 animate-pulse rounded-full bg-background/80 motion-reduce:animate-none" />
            </>
          ) : (
            <>
              <span className="font-mono text-sm font-medium tabular-nums text-foreground">
                {bestBid ?? bestAsk ?? "—"}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wider text-chart-3">
                {spread === "—" ? "No spread" : `Spread ${spread}`}
              </span>
            </>
          )}
        </div>
        <div className="h-56 min-h-0 flex-none overflow-y-auto overscroll-contain">
          {pending ? <LevelRowsSkeleton /> : null}
          {!pending && !error && !empty ? (
            <Table className="table-fixed">
              <LevelRows levels={bids} side="bid" onSelectLevel={onSelectLevel} />
            </Table>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
