"use client";

import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type PoolMetadata, useClobChain } from "@/lib/clob";
import { cn } from "@/lib/utils";

import type { Balance, MarketSummary, OpenOrder, RecentTrade } from "./market-data";
import { MarketDetails } from "./market-details";
import { formatCurrencyAmount } from "./market-details-formatting";
import { formatTimeAgo } from "./relative-time";

const accountTabs = ["Open Orders", "Assets", "Order History", "Recent Trades", "Market Details"] as const;
type AccountTab = (typeof accountTabs)[number];

const recentTradeSkeletonRows = [
  "trade-skeleton-1",
  "trade-skeleton-2",
  "trade-skeleton-3",
  "trade-skeleton-4",
  "trade-skeleton-5",
  "trade-skeleton-6",
  "trade-skeleton-7",
  "trade-skeleton-8",
  "trade-skeleton-9",
  "trade-skeleton-10",
];
const recentTradeSkeletonColumns = [
  { id: "time", width: "w-16" },
  { id: "market", width: "w-20" },
  { id: "type", width: "w-12" },
  { id: "price", width: "w-14" },
  { id: "size", width: "w-16" },
  { id: "account", width: "w-24" },
  { id: "transaction", width: "w-28" },
];

type AccountPanelProps = {
  connected: boolean;
  baseBalance: Balance | null;
  quoteBalance: Balance | null;
  orders: OpenOrder[];
  ordersLoading?: boolean;
  ordersError?: string | null;
  orderHistory: OpenOrder[];
  orderHistoryLoading?: boolean;
  orderHistoryError?: string | null;
  recentTrades: RecentTrade[];
  recentTradesLoading?: boolean;
  recentTradesError?: string | null;
  recentTradesPage: number;
  recentTradesPageSize: number;
  recentTradesTotal: number;
  market: MarketSummary;
  marketLoading?: boolean;
  pool: PoolMetadata | null;
  onCancel?: (orderId: `0x${string}`) => Promise<void>;
  onRecentTradesPageChange: (page: number) => void;
};

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid min-h-52 place-items-center px-6 py-10 text-center">
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">{title}</p>
        <p className="mt-2 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function formatStatus(status: string) {
  return status
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export function AccountPanel({
  connected,
  baseBalance,
  quoteBalance,
  orders,
  ordersLoading,
  ordersError,
  orderHistory,
  orderHistoryLoading,
  orderHistoryError,
  recentTrades,
  recentTradesLoading,
  recentTradesError,
  recentTradesPage,
  recentTradesPageSize,
  recentTradesTotal,
  market,
  marketLoading,
  pool,
  onCancel,
  onRecentTradesPageChange,
}: AccountPanelProps) {
  const { config } = useClobChain();
  const [activeTab, setActiveTab] = useState<AccountTab>("Open Orders");
  const [cancellingId, setCancellingId] = useState<`0x${string}` | null>(null);
  const [orderToCancel, setOrderToCancel] = useState<OpenOrder | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [relativeTimeNow, setRelativeTimeNow] = useState<number | null>(null);

  useEffect(() => {
    const updateRelativeTime = () => setRelativeTimeNow(Date.now());
    updateRelativeTime();
    const interval = window.setInterval(updateRelativeTime, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  async function cancel(orderId: `0x${string}`) {
    if (!onCancel) return;
    setCancelError(null);
    setCancellingId(orderId);
    try {
      await onCancel(orderId);
      setOrderToCancel(null);
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "The order could not be cancelled. Please try again.");
    } finally {
      setCancellingId(null);
    }
  }

  function content() {
    if (activeTab === "Assets") {
      if (!connected)
        return (
          <EmptyState
            title="Not connected"
            description="Connect a wallet to see your wallet and order escrow balances."
          />
        );
      const balances = [
        { asset: "base" as const, balance: baseBalance },
        { asset: "quote" as const, balance: quoteBalance },
      ].filter((entry): entry is { asset: "base" | "quote"; balance: Balance } => Boolean(entry.balance));
      if (!balances.length)
        return (
          <EmptyState
            title="Balances unavailable"
            description="Asset balances will appear after the wallet and market finish loading."
          />
        );
      return (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Asset</TableHead>
              <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">
                Available in wallet
              </TableHead>
              <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">In open orders</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.map(({ asset, balance }) => (
              <TableRow key={asset}>
                <TableCell className="px-4 py-3 text-xs font-medium">{balance.symbol}</TableCell>
                <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                  {formatCurrencyAmount(balance.free)}
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatCurrencyAmount(balance.locked)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }
    if (activeTab === "Open Orders") {
      if (!connected)
        return <EmptyState title="Not connected" description="Connect a wallet to see and manage your open orders." />;
      if (ordersError) return <EmptyState title="Orders unavailable" description={ordersError} />;
      if (ordersLoading)
        return <EmptyState title="Loading orders" description="Reading your active orders from the exchange." />;
      if (!orders.length)
        return <EmptyState title="No open orders" description="Resting limit orders will appear here." />;
      return (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Market</TableHead>
                <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Side / type</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Price</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Amount</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Filled</TableHead>
                <TableHead className="h-9 w-12 px-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.orderId}>
                  <TableCell className="px-4 py-2.5 text-xs font-medium">{order.market}</TableCell>
                  <TableCell className="px-4 py-2.5 text-xs">
                    <span className={cn("font-medium", order.side === "buy" ? "text-chart-3" : "text-destructive")}>
                      {order.side === "buy" ? "Buy" : "Sell"}
                    </span>
                    <span className="ml-1.5 text-muted-foreground">· {order.type}</span>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{order.price}</TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {order.amount}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {order.filled}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right">
                    <Button
                      aria-label={`Cancel ${order.side} order at ${order.price}`}
                      className="size-7 rounded-lg hover:bg-destructive/10 hover:text-destructive"
                      disabled={cancellingId === order.orderId}
                      onClick={() => {
                        setCancelError(null);
                        setOrderToCancel(order);
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      {cancellingId === order.orderId ? (
                        <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <X aria-hidden="true" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <AlertDialog
            onOpenChange={(open) => {
              if (!open && !cancellingId) {
                setOrderToCancel(null);
                setCancelError(null);
              }
            }}
            open={Boolean(orderToCancel)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                <AlertDialogDescription>
                  This submits an onchain cancellation. Any unfilled funds will return to your available balance.
                </AlertDialogDescription>
              </AlertDialogHeader>

              {orderToCancel ? (
                <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-2xl bg-muted/60 p-4 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Market</dt>
                    <dd className="mt-1 font-medium">{orderToCancel.market}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Side / type</dt>
                    <dd
                      className={cn(
                        "mt-1 font-medium",
                        orderToCancel.side === "buy" ? "text-chart-3" : "text-destructive",
                      )}
                    >
                      {orderToCancel.side === "buy" ? "Buy" : "Sell"} · {orderToCancel.type}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Price</dt>
                    <dd className="mt-1 font-mono tabular-nums">{orderToCancel.price}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Amount</dt>
                    <dd className="mt-1 font-mono tabular-nums">{orderToCancel.amount}</dd>
                  </div>
                </dl>
              ) : null}

              {cancelError ? (
                <p
                  aria-live="polite"
                  className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  role="alert"
                >
                  {cancelError}
                </p>
              ) : null}

              <AlertDialogFooter>
                <AlertDialogCancel disabled={Boolean(cancellingId)}>Keep order</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!orderToCancel || Boolean(cancellingId)}
                  onClick={() => {
                    if (orderToCancel) void cancel(orderToCancel.orderId);
                  }}
                  variant="destructive"
                >
                  {cancellingId ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="animate-spin motion-reduce:animate-none"
                      data-icon="inline-start"
                    />
                  ) : null}
                  {cancellingId ? "Cancelling…" : "Cancel order"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      );
    }
    if (activeTab === "Order History") {
      if (!connected)
        return <EmptyState title="Not connected" description="Connect a wallet to see your order history." />;
      if (orderHistoryError) return <EmptyState title="Order history unavailable" description={orderHistoryError} />;
      if (orderHistoryLoading)
        return <EmptyState title="Loading order history" description="Reading your orders from the exchange." />;
      if (!orderHistory.length)
        return <EmptyState title="No order history" description="Submitted orders will appear here." />;
      return (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Time</TableHead>
              <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Market</TableHead>
              <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Side / type</TableHead>
              <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Price</TableHead>
              <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Amount</TableHead>
              <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Filled</TableHead>
              <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orderHistory.map((order) => (
              <TableRow key={order.orderId}>
                <TableCell className="px-4 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                  {order.time}
                </TableCell>
                <TableCell className="px-4 py-2.5 text-xs font-medium">{order.market}</TableCell>
                <TableCell className="px-4 py-2.5 text-xs">
                  <span className={cn("font-medium", order.side === "buy" ? "text-chart-3" : "text-destructive")}>
                    {order.side === "buy" ? "Buy" : "Sell"}
                  </span>
                  <span className="ml-1.5 text-muted-foreground">· {order.type}</span>
                </TableCell>
                <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{order.price}</TableCell>
                <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {order.amount}
                </TableCell>
                <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {order.filled}
                </TableCell>
                <TableCell className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                  {formatStatus(order.status)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }
    if (activeTab === "Recent Trades") {
      if (recentTradesError) return <EmptyState title="Recent trades unavailable" description={recentTradesError} />;
      if (recentTradesLoading) {
        return (
          <div aria-busy="true" role="status">
            <span className="sr-only">Loading recent trades</span>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Time</TableHead>
                  <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Market</TableHead>
                  <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Trade type</TableHead>
                  <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Price</TableHead>
                  <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Size</TableHead>
                  <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Account</TableHead>
                  <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">
                    Transaction hash
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="animate-pulse motion-reduce:animate-none">
                {recentTradeSkeletonRows.slice(0, recentTradesPageSize).map((rowId) => (
                  <TableRow className="hover:bg-transparent" key={rowId}>
                    {recentTradeSkeletonColumns.map(({ id, width }, columnIndex) => (
                      <TableCell className="h-[37px] px-4 py-2.5" key={`${rowId}-${id}`}>
                        <span className={cn("block h-3 rounded-full bg-muted", width, columnIndex >= 3 && "ml-auto")} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex min-h-14 items-center justify-end gap-3 border-t border-border px-4">
              <span className="h-3 w-28 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              <span className="size-8 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
              <span className="h-3 w-20 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              <span className="size-8 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        );
      }
      if (!recentTrades.length)
        return <EmptyState title="No recent trades" description="Completed trades for this market will appear here." />;
      const explorerUrl = config.chain.blockExplorers?.default.url;
      const totalPages = Math.ceil(recentTradesTotal / recentTradesPageSize);
      const currentPage = Math.max(0, Math.min(recentTradesPage, totalPages - 1));
      const firstTradeIndex = currentPage * recentTradesPageSize;
      return (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Time</TableHead>
                <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Market</TableHead>
                <TableHead className="h-9 px-4 text-[10px] uppercase tracking-wider">Trade type</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Price</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Size</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">Account</TableHead>
                <TableHead className="h-9 px-4 text-right text-[10px] uppercase tracking-wider">
                  Transaction hash
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentTrades.map((trade) => (
                <TableRow key={trade.id}>
                  <TableCell className="px-4 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                    <time dateTime={new Date(trade.timestampMs).toISOString()} title={trade.time}>
                      {relativeTimeNow === null ? trade.time : formatTimeAgo(trade.timestampMs, relativeTimeNow)}
                    </time>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs font-medium">{trade.market}</TableCell>
                  <TableCell
                    className={cn(
                      "px-4 py-2.5 text-xs font-medium",
                      trade.side === "buy" ? "text-chart-3" : "text-destructive",
                    )}
                  >
                    {trade.side === "buy" ? "Buy" : "Sell"}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{trade.price}</TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {trade.size}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {explorerUrl ? (
                      <a
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        href={`${explorerUrl}/address/${trade.account}`}
                        rel="noreferrer"
                        target="_blank"
                        title={trade.account}
                      >
                        {shortHash(trade.account)}
                        <ExternalLink aria-hidden="true" className="size-3" />
                      </a>
                    ) : (
                      shortHash(trade.account)
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {trade.transactionHash && explorerUrl ? (
                      <a
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        href={`${explorerUrl}/tx/${trade.transactionHash}`}
                        rel="noreferrer"
                        target="_blank"
                        title={trade.transactionHash}
                      >
                        {shortHash(trade.transactionHash)}
                        <ExternalLink aria-hidden="true" className="size-3" />
                      </a>
                    ) : trade.transactionHash ? (
                      shortHash(trade.transactionHash)
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex min-h-14 flex-wrap items-center justify-end gap-3 border-t border-border px-4 py-2">
            <p className="font-mono text-xs tabular-nums text-muted-foreground">
              {firstTradeIndex + 1}–{firstTradeIndex + recentTrades.length} of {recentTradesTotal} trades
            </p>
            <nav aria-label="Recent trades pagination" className="flex items-center gap-2">
              <Button
                aria-label="Go to previous page"
                className="size-8 rounded-xl"
                disabled={currentPage === 0}
                onClick={() => onRecentTradesPageChange(currentPage - 1)}
                size="icon"
                variant="secondary"
              >
                <ChevronLeft aria-hidden="true" strokeWidth={1.5} />
              </Button>
              <span
                aria-live="polite"
                className="min-w-20 text-center font-mono text-xs tabular-nums text-muted-foreground"
              >
                Page {currentPage + 1} of {totalPages}
              </span>
              <Button
                aria-label="Go to next page"
                className="size-8 rounded-xl"
                disabled={currentPage === totalPages - 1}
                onClick={() => onRecentTradesPageChange(currentPage + 1)}
                size="icon"
                variant="secondary"
              >
                <ChevronRight aria-hidden="true" strokeWidth={1.5} />
              </Button>
            </nav>
          </div>
        </>
      );
    }
    if (activeTab === "Market Details") {
      return (
        <MarketDetails
          chainName={config.chain.name}
          explorerUrl={config.chain.blockExplorers?.default.url}
          factoryAddress={config.factoryAddress}
          loading={marketLoading}
          pool={pool}
          summary={market}
        />
      );
    }
    return null;
  }

  return (
    <section className="border-t border-border bg-background">
      <Tabs className="gap-0" onValueChange={(value) => setActiveTab(value as AccountTab)} value={activeTab}>
        <TabsList
          aria-label="Account views"
          className="h-12! w-full justify-start gap-0 overflow-x-auto rounded-none border-b border-border bg-transparent p-0"
          indicatorClassName="rounded-none border-0 bg-transparent after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary after:content-[''] dark:bg-transparent"
        >
          {accountTabs.map((tab) => (
            <TabsTrigger
              className="h-full flex-none shrink-0 rounded-none px-4 text-xs data-active:text-foreground"
              key={tab}
              value={tab}
            >
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
        <div role="tabpanel">{content()}</div>
      </Tabs>
    </section>
  );
}
