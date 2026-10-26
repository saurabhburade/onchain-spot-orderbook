"use client";

import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Wallet } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { type Address, formatUnits } from "viem";

import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WalletButton, WalletFundingActions } from "@/components/wallet-button";
import { useMarkets } from "@/hooks/clob/market-hooks";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useClobChain } from "@/lib/clob/chain-context";
import { listedTokenIconUrl } from "@/lib/clob/market-list";
import { formatPrice, formatQuantity, formatQuote } from "@/lib/clob/utils";
import { useClobWallet } from "@/lib/clob/wallet";
import { personalTradeLegs } from "@/lib/portfolio/activity";
import { orderHistoryPrice } from "@/lib/trading/order-history";
import { cn } from "@/lib/utils";

import { AssetAddress } from "./asset-address";

const tabs = [
  { value: "assets", label: "Assets" },
  { value: "trades", label: "Trades" },
  { value: "open-orders", label: "Open orders" },
  { value: "orders", label: "Order history" },
];
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function short(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function amount(value: bigint | null, decimals: number) {
  if (value === null) return "Unavailable";
  const exact = formatUnits(value, decimals);
  const [integer, fraction = ""] = exact.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  if (value > 0n && integer === "0" && !trimmed) return "<0.000001";
  const whole = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function RowsMessage({ children, columns, error = false }: { children: ReactNode; columns: number; error?: boolean }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        className={cn(
          "h-48 whitespace-normal px-6 text-center text-sm text-muted-foreground",
          error && "text-destructive",
        )}
        colSpan={columns}
      >
        <span role={error ? "alert" : "status"}>{children}</span>
      </TableCell>
    </TableRow>
  );
}

function TransactionLink({ hash }: { hash: string }) {
  const { config } = useClobChain();
  const explorer = config.chain.blockExplorers?.default.url;
  return explorer ? (
    <a
      className="inline-flex min-h-10 items-center gap-1.5 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-ring"
      href={`${explorer}/tx/${hash}`}
      rel="noreferrer"
      target="_blank"
      aria-label={`View transaction ${hash}`}
    >
      {short(hash)}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  ) : (
    <span className="font-mono text-xs text-muted-foreground" title={hash}>
      {short(hash)}
    </span>
  );
}

function Pagination({
  page,
  hasMore,
  busy,
  onChange,
}: {
  page: number;
  hasMore: boolean;
  busy?: boolean;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex min-h-14 items-center justify-end gap-3 border-t border-border px-4 py-2 sm:px-6 lg:px-5 xl:px-6">
      <span className="text-xs tabular-nums text-muted-foreground">Page {page + 1}</span>
      <Button
        aria-label="Previous page"
        className="size-8 rounded-full"
        disabled={page === 0 || busy}
        onClick={() => onChange(page - 1)}
        size="icon"
        variant="outline"
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button
        aria-label="Next page"
        className="size-8 rounded-full"
        disabled={!hasMore || busy}
        onClick={() => onChange(page + 1)}
        size="icon"
        variant="outline"
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
}

export function PortfolioScreen({ account }: { account?: Address }) {
  const { chainId } = useClobChain();
  const { tradingAddress } = useClobWallet();
  // Remount pagination and queries together when the account or network changes.
  const address = account ?? tradingAddress;
  return <AccountPortfolio account={address} key={`${chainId}:${address ?? "disconnected"}`} />;
}

function AccountPortfolio({ account }: { account: Address | null }) {
  const { chainId, config } = useClobChain();
  const { authenticated, tradingAddress } = useClobWallet();
  const isOwner = authenticated && Boolean(account && account.toLowerCase() === tradingAddress?.toLowerCase());
  const markets = useMarkets();
  const [tab, setTab] = useState("assets");
  const [tradesPage, setTradesPage] = useState(0);
  const [ordersPage, setOrdersPage] = useState(0);
  const [openOrdersPage, setOpenOrdersPage] = useState(0);
  const { balances, openOrders, openOrdersSummary, orderHistory, trades, refetchActivity } = usePortfolio(
    markets.data,
    account,
    { tab, tradesPage, openOrdersPage, ordersPage },
  );
  const selectedActivity = tab === "trades" ? trades : tab === "orders" ? orderHistory : openOrders;
  const connected = Boolean(account);
  const marketById = new Map(
    markets.data.map((market) => [`${market.clobAddress.toLowerCase()}:${market.poolId.toLowerCase()}`, market]),
  );
  const explorer = config.chain.blockExplorers?.default.url;
  const busy = balances.isFetching || openOrdersSummary.isFetching || selectedActivity.isFetching;

  function marketFor(order: { book: string; marketId: string }) {
    return marketById.get(`${order.book.toLowerCase()}:${order.marketId.toLowerCase()}`);
  }
  function marketLink(order: { book: string; marketId: string }) {
    const market = marketFor(order);
    return (
      <Link
        className="inline-flex min-h-10 items-center font-medium underline-offset-4 hover:underline"
        href={`/${chainId}/markets/${order.marketId}/trade`}
      >
        {market ? `${market.baseSymbol} / ${market.quoteSymbol}` : short(order.marketId)}
      </Link>
    );
  }
  function orderRows(query: typeof openOrders, pending: boolean) {
    const rows = query.data?.items ?? [];
    if (query.isPending) return <RowsMessage columns={7}>Loading your orders…</RowsMessage>;
    if (query.isError && !query.data)
      return (
        <RowsMessage columns={7} error>
          Order history is unavailable. Refresh to try again.
        </RowsMessage>
      );
    if (!rows.length)
      return (
        <RowsMessage columns={7}>
          {pending
            ? "No open orders. Your resting orders will appear here."
            : "No orders yet. Your order history will appear here after your first trade."}
        </RowsMessage>
      );
    return rows.map((order) => {
      const market = marketFor(order);
      return (
        <TableRow key={order.id}>
          <TableCell>{marketLink(order)}</TableCell>
          <TableCell>
            <span className={cn(order.side === "BUY" ? "text-chart-3" : "text-destructive")}>
              {order.side === "BUY" ? "Buy" : "Sell"}
            </span>
            <span className="ml-2 text-xs text-muted-foreground">{order.kind === "LIMIT" ? "Limit" : "Market"}</span>
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {market ? orderHistoryPrice(order, market, formatPrice(BigInt(order.price), market)) : "—"}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {market ? formatQuantity(BigInt(order.quantity), market) : "—"}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {market ? formatQuantity(BigInt(order.filledQuantity), market) : "—"}
          </TableCell>
          <TableCell className={cn("text-xs", order.status === "QUARANTINED" && "text-destructive")}>
            {order.status.toLowerCase().replaceAll("_", " ")}
          </TableCell>
          <TableCell className="text-right">
            <TransactionLink hash={order.createdTxHash} />
          </TableCell>
        </TableRow>
      );
    });
  }

  return (
    <main className="flex min-h-[calc(100dvh-7rem)] w-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6 lg:px-5 xl:px-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-balance text-base font-semibold tracking-tight">Portfolio</h1>
          {account ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="break-all font-mono" title={account}>
                {account}
              </span>
              <span>· {isOwner ? "Your trading wallet" : "Read-only view"}</span>
            </div>
          ) : null}
        </div>
        {connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              aria-label="Refresh portfolio"
              className="size-8 rounded-full"
              disabled={busy}
              onClick={() => {
                void markets.refetch();
                void balances.refetch();
                void refetchActivity();
              }}
              size="icon"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className={cn(busy && "animate-spin motion-reduce:animate-none")} />
            </Button>
            {isOwner ? <WalletFundingActions /> : null}
          </div>
        ) : null}
      </div>

      {!connected ? (
        <section className="flex min-h-64 flex-col items-center justify-center gap-4 border-b border-border px-6 py-10 text-center">
          <Wallet aria-hidden="true" className="size-8 text-muted-foreground" strokeWidth={1.5} />
          <h2 className="text-sm font-medium">Connect your wallet</h2>
          <WalletButton />
        </section>
      ) : (
        <>
          <dl className="grid grid-cols-3 divide-x divide-border border-b border-border">
            {[
              {
                title: "Assets held",
                value: balances.data
                  ? String(balances.data.filter((asset) => (asset.wallet ?? 0n) + (asset.locked ?? 0n) > 0n).length)
                  : "—",
              },
              {
                title: "Open orders",
                value: openOrdersSummary.data
                  ? `${openOrdersSummary.data.items.length}${openOrdersSummary.data.hasMore ? "+" : ""}`
                  : "—",
              },
              {
                title: "Markets",
                value: markets.loading && !markets.data.length ? "—" : String(markets.data.length),
              },
            ].map((stat) => (
              <div className="flex flex-col gap-2 px-4 py-4 sm:px-6 lg:px-5 xl:px-6" key={stat.title}>
                <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{stat.title}</dt>
                <dd className="font-mono text-xl font-medium tabular-nums">{stat.value}</dd>
              </div>
            ))}
          </dl>

          {markets.error ? (
            <p className="text-sm text-destructive" role="alert">
              Market discovery is unavailable. Balances may be incomplete. Refresh to try again.
            </p>
          ) : null}
          {selectedActivity.isError && selectedActivity.data ? (
            <p className="text-sm text-destructive" role="alert">
              Activity could not be refreshed. The last loaded history is shown.
            </p>
          ) : null}
          <section
            className="min-w-0 border-b border-border [&_table]:text-xs [&_th]:h-9 [&_th]:bg-muted/45 [&_th]:px-4 [&_th]:text-[10px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground [&_td]:px-4 [&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4 sm:[&_th:first-child]:pl-6 sm:[&_td:first-child]:pl-6 sm:[&_th:last-child]:pr-6 sm:[&_td:last-child]:pr-6 lg:[&_th:first-child]:pl-5 lg:[&_td:first-child]:pl-5 lg:[&_th:last-child]:pr-5 lg:[&_td:last-child]:pr-5 xl:[&_th:first-child]:pl-6 xl:[&_td:first-child]:pl-6 xl:[&_th:last-child]:pr-6 xl:[&_td:last-child]:pr-6"
            aria-label="Portfolio activity"
          >
            <Tabs className="gap-0" onValueChange={(value) => setTab(String(value))} value={tab}>
              <div className="overflow-x-auto border-b border-border px-0 sm:px-2 lg:px-1 xl:px-2">
                <TabsList
                  aria-label="Portfolio sections"
                  className="h-12! min-w-max justify-start gap-0 rounded-none bg-transparent p-0"
                  indicatorClassName="rounded-none border-0 bg-transparent after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:bg-primary after:content-[''] dark:bg-transparent"
                >
                  {tabs.map((item) => (
                    <TabsTrigger
                      className="h-full flex-none shrink-0 rounded-none px-4 text-xs"
                      key={item.value}
                      value={item.value}
                    >
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="assets">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asset</TableHead>
                      <TableHead className="text-right">Available in wallet</TableHead>
                      <TableHead className="text-right">In order escrow</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {balances.isPending ? (
                      <RowsMessage columns={4}>Loading wallet balances…</RowsMessage>
                    ) : balances.isError && !balances.data ? (
                      <RowsMessage columns={4} error>
                        Could not load balances. Refresh to try again.
                      </RowsMessage>
                    ) : (
                      balances.data?.map((asset) => (
                        <TableRow key={asset.key}>
                          <TableCell>
                            <div className="flex min-h-12 items-center gap-3">
                              <TokenIcon
                                className="size-8 bg-muted"
                                sizes="32px"
                                url={asset.address ? listedTokenIconUrl(chainId, asset.address) : undefined}
                              />
                              <div>
                                <p className="font-medium">{asset.symbol}</p>
                                {asset.address ? (
                                  <AssetAddress address={asset.address} explorer={explorer} />
                                ) : (
                                  <p className="mt-0.5 text-[11px] text-muted-foreground">Native coin</p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {amount(asset.wallet, asset.decimals)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                            {amount(asset.locked, asset.decimals)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {amount(
                              asset.wallet === null || asset.locked === null ? null : asset.wallet + asset.locked,
                              asset.decimals,
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                {balances.isError && balances.data ? (
                  <p className="px-5 pb-4 text-xs text-destructive" role="alert">
                    Balances could not be refreshed. The last loaded balances are shown.
                  </p>
                ) : null}
              </TabsContent>
              <TabsContent value="trades">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Market</TableHead>
                      <TableHead>Side / role</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Quote amount</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead className="text-right">Transaction</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades.isPending ? (
                      <RowsMessage columns={7}>Loading your trades…</RowsMessage>
                    ) : trades.isError && !trades.data ? (
                      <RowsMessage columns={7} error>
                        Trade history is unavailable. Refresh to try again.
                      </RowsMessage>
                    ) : !trades.data?.items.length ? (
                      <RowsMessage columns={7}>
                        No trades on this page. Your maker and taker fills will appear here.
                      </RowsMessage>
                    ) : (
                      trades.data.items.flatMap((trade) =>
                        personalTradeLegs(trade, account).map(({ side, role }) => {
                          const market = marketFor(trade);
                          return (
                            <TableRow key={`${trade.id}:${role}`}>
                              <TableCell>{marketLink(trade)}</TableCell>
                              <TableCell>
                                <span className={cn(side === "BUY" ? "text-chart-3" : "text-destructive")}>
                                  {side === "BUY" ? "Buy" : "Sell"}
                                </span>
                                <span className="ml-2 text-xs text-muted-foreground">{role}</span>
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {market ? formatPrice(BigInt(trade.price), market) : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {market
                                  ? `${formatQuantity(BigInt(trade.quantity), market)} ${market.baseSymbol}`
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {market
                                  ? `${formatQuote(BigInt(trade.quoteQuantity), market)} ${market.quoteSymbol}`
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                <time dateTime={new Date(trade.timestamp * 1000).toISOString()}>
                                  {dateFormatter.format(trade.timestamp * 1000)}
                                </time>
                              </TableCell>
                              <TableCell className="text-right">
                                <TransactionLink hash={trade.txHash} />
                              </TableCell>
                            </TableRow>
                          );
                        }),
                      )
                    )}
                  </TableBody>
                </Table>
                <Pagination
                  busy={trades.isFetching}
                  hasMore={trades.data?.hasMore ?? false}
                  onChange={setTradesPage}
                  page={tradesPage}
                />
              </TabsContent>
              {["open-orders", "orders"].map((value) => {
                const query = value === "open-orders" ? openOrders : orderHistory;
                const page = value === "open-orders" ? openOrdersPage : ordersPage;
                return (
                  <TabsContent key={value} value={value}>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Market</TableHead>
                          <TableHead>Side / type</TableHead>
                          <TableHead className="text-right">Price / avg. fill</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead className="text-right">Filled</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Transaction</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{orderRows(query, value === "open-orders")}</TableBody>
                    </Table>
                    <Pagination
                      hasMore={query.data?.hasMore ?? false}
                      busy={query.isFetching}
                      onChange={value === "open-orders" ? setOpenOrdersPage : setOrdersPage}
                      page={page}
                    />
                  </TabsContent>
                );
              })}
            </Tabs>
          </section>
        </>
      )}
    </main>
  );
}
