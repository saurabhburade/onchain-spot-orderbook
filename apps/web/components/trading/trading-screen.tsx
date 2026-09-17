"use client";

import { ExternalLink, WalletCards } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { MarketSelector } from "@/components/markets/market-selector";
import { Card, CardContent } from "@/components/ui/card";
import {
  formatPrice,
  formatQuantity,
  formatQuote,
  type PoolId,
  type PoolMetadata,
  type TradeExecuted,
  useClob,
  useClobChain,
  useClobWallet,
} from "@/lib/clob";
import { listedTokenIconUrl } from "@/lib/clob/market-list";
import { type IndexedTrade, useIndexerMarketDetail, useIndexerOrderHistory, useRpcFirstMarkets } from "@/lib/indexer";

import { AccountPanel } from "./account-panel";
import type {
  Balance,
  MarketSummary,
  OpenOrder,
  OrderBookLevel,
  RecentTrade,
  TransactionFeedback,
} from "./market-data";
import { deriveMarketSummary, type PriceCandle } from "./market-stats";
import { OrderBook } from "./order-book";
import { orderHistoryPrice } from "./order-history";
import { PriceChart } from "./price-chart";
import { TradeTicket } from "./trade-ticket";

const ORDERBOOK_DEPTH = 50;

function EmptyHome() {
  const { chainId, config } = useClobChain();
  const defaultPool = config.defaultPoolId;
  return (
    <main className="mx-auto flex min-h-[calc(100vh-64px)] w-full max-w-[1540px] items-center px-4 py-10 sm:px-6 lg:px-8 xl:px-10">
      <Card className="mx-auto w-full max-w-2xl ring-1 ring-border/60">
        <CardContent className="flex flex-col items-center px-6 py-14 text-center sm:px-12">
          <span className="mb-5 grid size-14 place-items-center rounded-2xl bg-muted text-foreground">
            <WalletCards aria-hidden="true" className="size-6" />
          </span>
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            Trade spot markets on-chain
          </h1>
          <p className="mt-3 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
            Connect to a deployed market to see its live order book, balances, recent trades, and open orders.
          </p>
          {defaultPool ? (
            <Link
              className="mt-7 inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
              href={`/${chainId}/markets/${defaultPool}/trade`}
            >
              Open default market <ExternalLink aria-hidden="true" data-icon="inline-end" />
            </Link>
          ) : (
            <Link
              className="mt-7 inline-flex h-9 items-center justify-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
              href={`/${chainId}/markets`}
            >
              Browse markets
            </Link>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function MarketHeader({
  summary,
  loading,
  pool,
}: {
  summary: MarketSummary;
  loading: boolean;
  pool: PoolMetadata | null;
}) {
  const router = useRouter();
  const { chainId } = useClobChain();
  const markets = useRpcFirstMarkets();
  return (
    <div className="flex flex-col gap-4 sm:grid sm:min-h-[4.25rem] sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-stretch sm:gap-0">
      <div className="flex min-w-0 items-stretch border-r-[0.5px] border-border">
        <MarketSelector
          currentBaseIconUrl={pool ? listedTokenIconUrl(chainId, pool.baseAsset) : undefined}
          currentPoolId={summary.poolId}
          currentQuoteIconUrl={pool ? listedTokenIconUrl(chainId, pool.quoteAsset) : undefined}
          currentSymbol={summary.symbol}
          loading={markets.loading}
          markets={markets.data}
          onSelect={(poolId) => {
            if (poolId !== summary.poolId) router.push(`/${chainId}/markets/${poolId}/trade`);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-4 text-xs sm:grid-cols-4 sm:gap-y-0 sm:px-5">
        {[
          ["Market type", "Spot"],
          ["Last price", summary.price ?? "Not available"],
          ["24h change", summary.change ?? "Not available"],
          ["24h volume", summary.volume ?? "Not available"],
        ].map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
            {loading && label !== "Market type" ? (
              <>
                <span className="sr-only">{`Loading ${label.toLowerCase()}`}</span>
                <span
                  aria-hidden="true"
                  className="mt-1 block h-4 w-14 animate-pulse rounded-full bg-muted motion-reduce:animate-none"
                />
              </>
            ) : (
              <p
                className={`mt-1 whitespace-nowrap font-mono tabular-nums ${
                  label === "Market type" || (label === "24h change" && summary.change?.startsWith("+"))
                    ? "text-chart-3"
                    : label === "24h change" && summary.change?.startsWith("-")
                      ? "text-destructive"
                      : "text-foreground"
                }`}
              >
                {value}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function displayLevels(levels: { price: string; quantity: string; quoteValue: string }[]): OrderBookLevel[] {
  const values = levels.map((level) => Number.parseFloat(level.quantity)).filter(Number.isFinite);
  const max = Math.max(...values, 0);
  return levels.map((level) => ({
    price: level.price,
    size: level.quantity,
    total: level.quoteValue,
    depth: max > 0 ? Math.min(100, (Number.parseFloat(level.quantity) / max) * 100) : 0,
  }));
}

function formatHistoryTime(timestamp: bigint) {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

function indexedTrade(trade: IndexedTrade, pool: PoolMetadata): TradeExecuted {
  return {
    poolId: trade.marketId,
    takerOrderId: trade.takerOrderId,
    makerOrderId: trade.makerOrderId,
    baseAsset: trade.baseAsset,
    quoteAsset: trade.quoteAsset,
    priceRaw: BigInt(trade.price),
    quantityLots: BigInt(trade.quantity),
    quoteQuantityRaw: BigInt(trade.quoteQuantity),
    price: formatPrice(BigInt(trade.price), pool),
    quantity: formatQuantity(BigInt(trade.quantity), pool),
    quoteQuantity: formatQuote(BigInt(trade.quoteQuantity), pool),
    timestamp: BigInt(trade.timestamp),
    blockNumber: BigInt(trade.blockNumber),
    transactionHash: trade.txHash,
    logIndex: trade.logIndex,
  };
}

function recentTrade(trade: TradeExecuted, symbol: string, side: "buy" | "sell", account: string): RecentTrade {
  return {
    id: `${trade.transactionHash}:${trade.logIndex}`,
    time: new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(Number(trade.timestamp) * 1_000),
    timestampMs: Number(trade.timestamp) * 1_000,
    market: symbol,
    price: trade.price,
    size: trade.quantity,
    side,
    account,
    transactionHash: trade.transactionHash,
  };
}

function MarketTradingView({ marketId }: { marketId: PoolId }) {
  const clob = useClob(marketId, ORDERBOOK_DEPTH);
  const indexed = useIndexerMarketDetail(marketId);
  const { config } = useClobChain();
  const { authenticated, connect, ready, tradingAddress, wallet } = useClobWallet();
  const indexedOrderHistory = useIndexerOrderHistory(marketId, tradingAddress ?? undefined);
  const pool = clob.pool.data;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [selectedOrder, setSelectedOrder] = useState<{ marketId: PoolId; price: string; size: string } | null>(null);
  const dayTrades = useMemo(
    () => (pool ? (indexed.data?.dayTrades ?? []).map((trade) => indexedTrade(trade, pool)) : []),
    [indexed.data?.dayTrades, pool],
  );
  const summary = useMemo<MarketSummary>(() => {
    const indexedLastPrice = indexed.data?.market?.lastPrice;
    const lastPrice =
      pool && indexedLastPrice && BigInt(indexedLastPrice) > 0n
        ? formatPrice(BigInt(indexedLastPrice), pool)
        : (clob.bestPrices.data?.ask?.price ?? clob.bestPrices.data?.bid?.price ?? null);
    return deriveMarketSummary(
      {
        poolId: marketId,
        symbol: pool ? `${pool.baseSymbol} / ${pool.quoteSymbol}` : "Market",
        baseAsset: pool?.baseSymbol ?? "BASE",
        quoteAsset: pool?.quoteSymbol ?? "QUOTE",
        price: lastPrice,
      },
      dayTrades,
    );
  }, [clob.bestPrices.data, dayTrades, indexed.data?.market?.lastPrice, marketId, pool]);
  const candles = useMemo<PriceCandle[]>(
    () =>
      pool
        ? (indexed.data?.candles ?? []).map((candle) => ({
            timestamp: candle.startTimestamp,
            open: Number(formatPrice(BigInt(candle.open), pool)),
            high: Number(formatPrice(BigInt(candle.high), pool)),
            low: Number(formatPrice(BigInt(candle.low), pool)),
            close: Number(formatPrice(BigInt(candle.close), pool)),
            volume: Number(formatQuote(BigInt(candle.quoteVolume), pool)),
          }))
        : [],
    [indexed.data?.candles, pool],
  );
  const latestTrades = useMemo(
    () =>
      pool
        ? (indexed.data?.latestTrades ?? []).map((trade) =>
            recentTrade(
              indexedTrade(trade, pool),
              `${pool.baseSymbol}/${pool.quoteSymbol}`,
              trade.side === "BUY" ? "buy" : "sell",
              trade.account,
            ),
          )
        : [],
    [indexed.data?.latestTrades, pool],
  );
  const quoteBalance: Balance | null = clob.balances.data?.quote
    ? {
        symbol: clob.balances.data.quote.symbol,
        free: clob.balances.data.quote.wallet,
        locked: clob.balances.data.quote.locked,
        wallet: clob.balances.data.quote.wallet,
      }
    : null;
  const baseBalance: Balance | null = clob.balances.data?.base
    ? {
        symbol: clob.balances.data.base.symbol,
        free: clob.balances.data.base.wallet,
        locked: clob.balances.data.base.locked,
        wallet: clob.balances.data.base.wallet,
      }
    : null;
  const transaction: TransactionFeedback = {
    status: clob.transaction.status,
    message:
      clob.transaction.error?.message ??
      (clob.transaction.status === "submitted"
        ? "Transaction submitted."
        : clob.transaction.status === "success"
          ? "Transaction submitted."
          : undefined),
    hash: clob.transaction.hash,
  };
  const runLimit = async (input: { side: "buy" | "sell"; price: string; quantity: string }) => {
    await clob.placeLimit({ ...input });
  };
  const runMarket = async (input: { side: "buy" | "sell"; quantity: string }) => {
    await clob.executeMarket({ ...input });
  };
  const mapOpenOrder = useCallback(
    (order: (typeof clob.orderHistory.data)[number]): OpenOrder => ({
      orderId: order.orderId,
      market: summary.symbol,
      side: order.side,
      type: order.kind === "market" ? "Market" : "Limit",
      price: order.price,
      amount: `${order.quantity} ${summary.baseAsset}`,
      filled: `${order.filled} ${summary.baseAsset}`,
      status: order.status,
      time: order.createdAt ? formatHistoryTime(order.createdAt) : "Pending",
      transactionHash: order.transactionHash,
    }),
    [summary.baseAsset, summary.symbol],
  );
  const orders = useMemo(() => clob.openOrders.data.map(mapOpenOrder), [clob.openOrders.data, mapOpenOrder]);
  const orderHistory = useMemo<OpenOrder[]>(
    () =>
      pool
        ? (indexedOrderHistory.data ?? []).map((order) => ({
            orderId: order.orderId,
            market: summary.symbol,
            side: order.side === "BUY" ? "buy" : "sell",
            type: order.kind === "MARKET" ? "Market" : "Limit",
            price: orderHistoryPrice(order, pool, formatPrice(BigInt(order.price), pool)),
            amount: `${formatQuantity(BigInt(order.quantity), pool)} ${summary.baseAsset}`,
            filled: `${formatQuantity(BigInt(order.filledQuantity), pool)} ${summary.baseAsset}`,
            status: order.status.toLowerCase().replaceAll("_", "-"),
            time: formatHistoryTime(BigInt(order.createdAt)),
            transactionHash: order.createdTxHash,
          }))
        : [],
    [indexedOrderHistory.data, pool, summary.baseAsset, summary.symbol],
  );
  const marketError = clob.pool.error?.message ?? null;
  return (
    <main className="w-full">
      <div className="grid items-stretch gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_280px_300px] lg:grid-rows-[4.25rem_minmax(464px,auto)] lg:gap-0 lg:p-0 xl:grid-cols-[minmax(0,1fr)_340px_320px] 2xl:grid-cols-[minmax(0,1fr)_384px_380px]">
        <div className="border-b-[0.5px] border-border lg:col-span-2 lg:col-start-1 lg:row-start-1 lg:border-r-[0.5px] xl:col-span-1">
          <MarketHeader loading={clob.pool.loading || indexed.isPending} pool={pool} summary={summary} />
        </div>
        <PriceChart candles={candles} error={indexed.error?.message} loading={indexed.isPending} summary={summary} />
        <OrderBook
          baseSymbol={summary.baseAsset}
          bestPrices={clob.bestPrices.data}
          depth={ORDERBOOK_DEPTH}
          error={clob.orderbook.error?.message ?? marketError}
          loading={clob.orderbook.loading}
          onSelectLevel={(level) => setSelectedOrder({ marketId, price: level.price, size: level.size })}
          orderbook={
            clob.orderbook.data
              ? { asks: displayLevels(clob.orderbook.data.asks), bids: displayLevels(clob.orderbook.data.bids) }
              : null
          }
          quoteSymbol={summary.quoteAsset}
        />
        <aside className="space-y-4 lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:flex lg:h-full lg:flex-col lg:space-y-0">
          <TradeTicket
            baseBalance={baseBalance}
            connected={authenticated && Boolean(wallet)}
            explorerUrl={config.chain.blockExplorers?.default.url}
            onConnect={connect}
            onLimitOrder={runLimit}
            onMarketOrder={runMarket}
            onSideChange={setSide}
            quoteBalance={quoteBalance}
            ready={ready}
            selectedOrder={selectedOrder?.marketId === marketId ? selectedOrder : null}
            side={side}
            summary={summary}
            transaction={transaction}
            tradingFeeBps={pool?.tradingFeeBps ?? null}
            marketPrice={
              side === "buy" ? (clob.bestPrices.data?.ask?.price ?? null) : (clob.bestPrices.data?.bid?.price ?? null)
            }
          />
        </aside>
      </div>
      <AccountPanel
        baseBalance={baseBalance}
        connected={authenticated && Boolean(wallet)}
        market={summary}
        marketLoading={clob.pool.loading || indexed.isPending}
        onCancel={async (orderId) => {
          await clob.cancel(orderId);
        }}
        orderHistory={orderHistory}
        orderHistoryError={indexedOrderHistory.error?.message ?? marketError}
        orderHistoryLoading={indexedOrderHistory.isPending}
        orders={orders}
        ordersError={clob.openOrders.error?.message ?? marketError}
        ordersLoading={clob.openOrders.loading}
        pool={pool}
        quoteBalance={quoteBalance}
        recentTrades={latestTrades}
        recentTradesError={indexed.error?.message}
        recentTradesLoading={indexed.isPending}
      />
    </main>
  );
}

export function TradingScreen({ marketId }: { marketId?: PoolId }) {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {marketId ? <MarketTradingView marketId={marketId} /> : <EmptyHome />}
    </div>
  );
}
