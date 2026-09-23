"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, WalletCards } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
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
import { type IndexedTrade, type TradingIndexerSnapshot, useRpcFirstMarkets } from "@/lib/indexer";
import { refreshIndexedRecentTrades } from "@/lib/indexer/recent-trades-action";
import type {
  Balance,
  MarketSummary,
  OpenOrder,
  OrderBookLevel,
  RecentTrade,
  TransactionFeedback,
} from "@/lib/trading/market-data";
import { missingMarketRecoveryPath } from "@/lib/trading/market-route";
import { deriveMarketSummary, type PriceCandle } from "@/lib/trading/market-stats";
import { orderHistoryPrice } from "@/lib/trading/order-history";
import { MarketSelector } from "@/views/markets/components/market-selector";
import { AccountPanel } from "./account-panel";
import { OrderBook } from "./order-book";
import { PriceChart } from "./price-chart";
import { TradeTicket } from "./trade-ticket";

const showTransactionLatency = process.env.NODE_ENV !== "production";

const ORDERBOOK_DEPTH = 50;
const RECENT_TRADES_PAGE_SIZE = 10;

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
  markets,
}: {
  summary: MarketSummary;
  loading: boolean;
  pool: PoolMetadata | null;
  markets: ReturnType<typeof useRpcFirstMarkets>;
}) {
  const router = useRouter();
  const { chainId } = useClobChain();
  const statistics = [
    ["Market type", "Spot"],
    ["Last price", summary.price ?? "Not available"],
    ["24h change", summary.change ?? "Not available"],
    ["24h volume", summary.volume ?? "Not available"],
  ] as const;
  return (
    <div className="grid min-h-[4.25rem] grid-cols-2 items-stretch border-b-[0.5px] border-border sm:grid-cols-[13rem_minmax(0,1fr)] sm:border-b-0">
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
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-3 sm:hidden">
        <p className="min-w-0 truncate font-mono text-lg font-medium tabular-nums text-foreground">
          {loading ? "—" : (summary.price ?? "—")}
        </p>
        <p
          className={`shrink-0 font-mono text-xs tabular-nums ${
            summary.change?.startsWith("+")
              ? "text-chart-3"
              : summary.change?.startsWith("-")
                ? "text-destructive"
                : "text-muted-foreground"
          }`}
        >
          {loading ? "Loading…" : (summary.change ?? "No 24h change")}
        </p>
      </div>
      <div className="hidden grid-cols-2 gap-x-4 gap-y-3 py-4 text-xs sm:grid sm:grid-cols-4 sm:gap-y-0 sm:px-5">
        {statistics.map(([label, value]) => (
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

function MarketTradingView({ marketId, indexer }: { marketId: PoolId; indexer: TradingIndexerSnapshot }) {
  const router = useRouter();
  const clob = useClob(marketId, ORDERBOOK_DEPTH);
  const { chainId, config } = useClobChain();
  const { authenticated, connect, ready, wallet } = useClobWallet();
  const pool = clob.pool.data;
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [indexerNavigating, startIndexerNavigation] = useTransition();
  const [selectedOrder, setSelectedOrder] = useState<{ marketId: PoolId; price: string; size: string } | null>(null);
  const indexed = indexer.marketDetail;
  const indexedRecentTrades = indexer.recentTrades;
  const recentTradesPage = indexer.recentTradesPage;
  const recentTradesQuery = useQuery({
    queryKey: ["indexed-recent-trades", chainId, marketId, recentTradesPage],
    queryFn: () => refreshIndexedRecentTrades({ chainId, marketId, page: recentTradesPage }),
    initialData: indexedRecentTrades.data,
    refetchInterval: 1_000,
    staleTime: 0,
  });
  const refreshedRecentTrades = recentTradesQuery.data;
  const indexedRecentTradesTotal = refreshedRecentTrades.totalCount;
  const recentTradesTotal = indexedRecentTradesTotal;
  const markets = useRpcFirstMarkets(indexer.marketListings.data, indexer.marketListings.error);
  const updateIndexerRoute = useCallback(
    (page: number) => {
      const search = new URLSearchParams(window.location.search);
      if (page > 0) search.set("tradesPage", String(page));
      else search.delete("tradesPage");
      search.delete("trader");
      const query = search.toString();
      startIndexerNavigation(() => {
        router.replace(`${window.location.pathname}${query ? `?${query}` : ""}`, { scroll: false });
      });
    },
    [router],
  );
  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(indexedRecentTradesTotal / RECENT_TRADES_PAGE_SIZE) - 1);
    if (recentTradesPage > lastPage) updateIndexerRoute(lastPage);
  }, [indexedRecentTradesTotal, recentTradesPage, updateIndexerRoute]);
  const dayTrades = useMemo(
    () => (pool ? indexed.data.dayTrades.map((trade) => indexedTrade(trade, pool)) : []),
    [indexed.data.dayTrades, pool],
  );
  const summary = useMemo<MarketSummary>(() => {
    const indexedLastPrice = indexed.data.market?.lastPrice;
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
  }, [clob.bestPrices.data, dayTrades, indexed.data.market?.lastPrice, marketId, pool]);
  const candles = useMemo<PriceCandle[]>(
    () =>
      pool
        ? indexed.data.candles.map((candle) => ({
            timestamp: candle.startTimestamp,
            open: Number(formatPrice(BigInt(candle.open), pool)),
            high: Number(formatPrice(BigInt(candle.high), pool)),
            low: Number(formatPrice(BigInt(candle.low), pool)),
            close: Number(formatPrice(BigInt(candle.close), pool)),
            volume: Number(formatQuote(BigInt(candle.quoteVolume), pool)),
          }))
        : [],
    [indexed.data.candles, pool],
  );
  const latestTrades = useMemo(
    () =>
      pool
        ? refreshedRecentTrades.trades.map((trade) =>
            recentTrade(
              indexedTrade(trade, pool),
              `${pool.baseSymbol}/${pool.quoteSymbol}`,
              trade.side === "BUY" ? "buy" : "sell",
              trade.account,
            ),
          )
        : [],
    [refreshedRecentTrades.trades, pool],
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
  const latencyDetails =
    showTransactionLatency && clob.transaction.metrics
      ? [
          clob.transaction.metrics.setupMs ? `one-time setup ${clob.transaction.metrics.setupMs} ms` : null,
          clob.transaction.metrics.prepareMs !== undefined
            ? clob.transaction.metrics.prepareBreakdown
              ? `prepare API ${clob.transaction.metrics.prepareMs} ms [browser↔API/Next ${clob.transaction.metrics.prepareBreakdown.networkMs} ms, auth ${clob.transaction.metrics.prepareBreakdown.authMs} ms, RPC wall ${clob.transaction.metrics.prepareBreakdown.rpcWallMs} ms (nonce ${clob.transaction.metrics.prepareBreakdown.nonceMs}, delegation ${clob.transaction.metrics.prepareBreakdown.delegationMs}, order book ${clob.transaction.metrics.prepareBreakdown.orderBookMs}, chain ${clob.transaction.metrics.prepareBreakdown.chainIdMs}), local validate/hash ${clob.transaction.metrics.prepareBreakdown.localMs} ms, response ${clob.transaction.metrics.prepareBreakdown.responseMs} ms]`
              : `local prepare ${clob.transaction.metrics.prepareMs} ms`
            : null,
          `local sign ${clob.transaction.metrics.signMs} ms`,
          clob.transaction.metrics.submitBreakdown
            ? `submit API ${clob.transaction.metrics.submitMs} ms [browser↔API/Next ${clob.transaction.metrics.submitBreakdown.networkMs} ms, auth ${clob.transaction.metrics.submitBreakdown.authMs} ms, RPC batch wall ${clob.transaction.metrics.submitBreakdown.validationWallMs} ms (chain ${clob.transaction.metrics.submitBreakdown.chainIdMs}, delegation ${clob.transaction.metrics.submitBreakdown.delegationMs}, order book ${clob.transaction.metrics.submitBreakdown.orderBookMs}, policy ${clob.transaction.metrics.submitBreakdown.policyRpcMs}, UserOp nonce ${clob.transaction.metrics.submitBreakdown.nonceMs}, hash ${clob.transaction.metrics.submitBreakdown.hashMs}, simulation ${clob.transaction.metrics.submitBreakdown.simulationMs}, sponsor fields ${clob.transaction.metrics.submitBreakdown.broadcastPrepareMs} [nonce ${clob.transaction.metrics.submitBreakdown.sponsorNonceMs}, gas price ${clob.transaction.metrics.submitBreakdown.gasPriceMs}]), broadcast ${clob.transaction.metrics.submitBreakdown.broadcastMs} ms (sponsor sign ${clob.transaction.metrics.submitBreakdown.sponsorSignMs}, eth_sendRawTransaction ${clob.transaction.metrics.submitBreakdown.rpcSubmissionMs}), response ${clob.transaction.metrics.submitBreakdown.responseMs} ms]`
            : `submit API ${clob.transaction.metrics.submitMs} ms`,
        ]
          .filter(Boolean)
          .join(", ")
      : null;
  const transaction: TransactionFeedback = {
    status: clob.transaction.status,
    message:
      clob.transaction.error?.message ??
      (showTransactionLatency && clob.transaction.metrics
        ? `Submitted in ${clob.transaction.metrics.totalMs} ms (${latencyDetails}).`
        : clob.transaction.status === "submitted"
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
  const mapHistoryOrder = useCallback(
    (order: (typeof clob.orderHistory.data)[number]): OpenOrder => ({
      ...mapOpenOrder(order),
      price: pool
        ? orderHistoryPrice(
            {
              filledQuantity: order.filledQuantityLots.toString(),
              kind: order.kind === "market" ? "MARKET" : "LIMIT",
              quoteQuantity: order.filledQuoteQuantity.toString(),
            },
            pool,
            order.price,
          )
        : order.price,
    }),
    [mapOpenOrder, pool],
  );
  const orders = useMemo(() => clob.openOrders.data.map(mapOpenOrder), [clob.openOrders.data, mapOpenOrder]);
  const orderHistory = useMemo<OpenOrder[]>(
    () => clob.orderHistory.data.map(mapHistoryOrder),
    [clob.orderHistory.data, mapHistoryOrder],
  );
  const marketError = clob.pool.error?.message ?? null;
  const recoveryPath = missingMarketRecoveryPath({
    chainId,
    currentPoolId: marketId,
    defaultPoolId: config.defaultPoolId,
    errorMessage: marketError,
  });
  useEffect(() => {
    if (recoveryPath) router.replace(recoveryPath);
  }, [recoveryPath, router]);

  if (recoveryPath) {
    return (
      <main className="grid min-h-[calc(100vh-64px)] place-items-center px-6 text-sm text-muted-foreground">
        Redirecting to an active market…
      </main>
    );
  }

  return (
    <main className="w-full">
      <div className="grid grid-cols-2 items-stretch gap-0 lg:grid-cols-[minmax(0,1fr)_280px_300px] lg:grid-rows-[4.25rem_minmax(464px,auto)] xl:grid-cols-[minmax(0,1fr)_340px_320px] 2xl:grid-cols-[minmax(0,1fr)_384px_380px]">
        <div className="col-span-2 border-b-[0.5px] border-border lg:col-span-2 lg:col-start-1 lg:row-start-1 lg:border-r-[0.5px] xl:col-span-1">
          <MarketHeader loading={clob.pool.loading} markets={markets} pool={pool} summary={summary} />
        </div>
        <div className="hidden min-w-0 lg:contents">
          <PriceChart candles={candles} error={indexed.error ?? undefined} loading={false} summary={summary} />
        </div>
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
          className="col-start-2 row-start-2"
          mobileCompact
        />
        <aside className="col-start-1 row-start-2 min-w-0 border-r-[0.5px] border-border lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:flex lg:h-full lg:flex-col lg:border-r-0 lg:space-y-0">
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
            mobileCompact
          />
        </aside>
      </div>
      <AccountPanel
        baseBalance={baseBalance}
        connected={authenticated && Boolean(wallet)}
        market={summary}
        marketLoading={clob.pool.loading}
        onCancel={async (orderId) => {
          await clob.cancel(orderId);
        }}
        onRecentTradesPageChange={updateIndexerRoute}
        orderHistory={orderHistory}
        orderHistoryError={clob.orderHistory.error?.message ?? marketError}
        orderHistoryLoading={clob.orderHistory.loading}
        orders={orders}
        ordersError={clob.openOrders.error?.message ?? marketError}
        ordersLoading={clob.openOrders.loading}
        pool={pool}
        quoteBalance={quoteBalance}
        recentTrades={latestTrades}
        recentTradesError={
          recentTradesQuery.error
            ? "Indexer data is temporarily unavailable"
            : recentTradesQuery.isFetchedAfterMount
              ? null
              : indexedRecentTrades.error
        }
        recentTradesLoading={indexerNavigating}
        recentTradesPage={recentTradesPage}
        recentTradesPageSize={RECENT_TRADES_PAGE_SIZE}
        recentTradesTotal={recentTradesTotal}
      />
    </main>
  );
}

export function TradingScreen({ marketId, indexer }: { marketId?: PoolId; indexer?: TradingIndexerSnapshot }) {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {marketId && indexer ? <MarketTradingView indexer={indexer} key={marketId} marketId={marketId} /> : <EmptyHome />}
    </div>
  );
}
