import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { formatPrice, formatQuantity, formatQuote, type PoolMetadata } from "@/lib/clob";
import { quoteAmountRaw } from "@/lib/clob/utils";
import type { MarketSummary } from "@/lib/trading/market-data";
import { formatLastPrice } from "@/lib/trading/market-details-formatting";
import { formatTradingFeeRate } from "@/lib/trading/trade-ticket-fee";
import { cn } from "@/lib/utils";

const maxUint128 = (1n << 128n) - 1n;

type MarketDetailsProps = {
  chainName: string;
  explorerUrl?: string;
  factoryAddress?: `0x${string}`;
  loading?: boolean;
  pool: PoolMetadata | null;
  summary: MarketSummary;
};

function formatPriceKeyRange(pool: PoolMetadata) {
  if (pool.agnosticPricing) return "1–2¹²⁸−1";
  return `${pool.minTick.toLocaleString()}–${pool.maxTick.toLocaleString()}`;
}

function minimumQuantity(pool: PoolMetadata) {
  if (pool.agnosticPricing) return "Dynamic by limit price";
  return `${formatQuantity(1n, pool)} ${pool.baseSymbol}`;
}

function minimumOrderValue(pool: PoolMetadata) {
  if (pool.agnosticPricing) return `${formatQuote(1n, pool)} ${pool.quoteSymbol}`;
  const minimumPriceRaw = pool.minTick * pool.tickSize;
  return `${formatQuote(quoteAmountRaw(minimumPriceRaw, 1n, pool), pool)} ${pool.quoteSymbol}`;
}

function pricePrecision(pool: PoolMetadata) {
  if (pool.agnosticPricing) return `1e-18 ${pool.quoteSymbol} per ${pool.baseSymbol}`;
  return `${formatPrice(pool.tickSize, pool)} ${pool.quoteSymbol} per ${pool.baseSymbol}`;
}

function priceRange(pool: PoolMetadata, boundary: "minimum" | "maximum") {
  const priceRaw = pool.agnosticPricing
    ? boundary === "minimum"
      ? 1n
      : maxUint128
    : (boundary === "minimum" ? pool.minTick : pool.maxTick) * pool.tickSize;
  return `${formatPrice(priceRaw, pool)} ${pool.quoteSymbol}`;
}

function DetailItem({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <div className={cn("min-w-0 px-4 py-3.5 sm:px-5", className)}>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 min-w-0 text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}

function StatValue({
  children,
  nowrap = false,
  tone,
}: {
  children: ReactNode;
  nowrap?: boolean;
  tone?: "positive" | "negative";
}) {
  return (
    <span
      className={cn(
        "font-mono text-sm font-semibold break-all tabular-nums",
        nowrap && "whitespace-nowrap",
        tone === "positive" && "text-chart-3",
        tone === "negative" && "text-destructive",
      )}
    >
      {children}
    </span>
  );
}

function ExplorerLink({ address, explorerUrl, label }: { address: string; explorerUrl?: string; label: string }) {
  const content = <span className="break-all font-mono text-xs tabular-nums">{address}</span>;

  if (!explorerUrl) return content;
  return (
    <a
      aria-label={`View ${label} on block explorer`}
      className="inline-flex max-w-full items-start gap-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={`${explorerUrl}/address/${address}`}
      rel="noreferrer"
      target="_blank"
    >
      {content}
      <ExternalLink aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
    </a>
  );
}

export function MarketDetails({ chainName, explorerUrl, factoryAddress, loading, pool, summary }: MarketDetailsProps) {
  if (!pool) {
    return (
      <div className="grid min-h-52 place-items-center px-6 py-10 text-center">
        <div>
          <p className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground">
            {loading ? "Loading market details" : "Market details unavailable"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {loading
              ? "Reading the selected market configuration from the registry."
              : "The selected market configuration could not be loaded."}
          </p>
        </div>
      </div>
    );
  }

  const changeTone = summary.change?.startsWith("+")
    ? "positive"
    : summary.change?.startsWith("-")
      ? "negative"
      : undefined;
  const lastPrice = formatLastPrice(summary.price);

  return (
    <div>
      <section aria-labelledby="market-statistics-heading">
        <h2 className="sr-only" id="market-statistics-heading">
          Market statistics
        </h2>
        <dl className="grid border-b border-border sm:grid-cols-2 lg:grid-cols-3 [&>*]:border-b [&>*]:border-border sm:[&>*]:border-r sm:[&>*:nth-child(2n)]:border-r-0 lg:[&>*:nth-child(2n)]:border-r lg:[&>*:nth-child(3n)]:border-r-0">
          <DetailItem label="Last price">
            <StatValue nowrap>{lastPrice ? `${lastPrice} ${pool.quoteSymbol}` : "—"}</StatValue>
          </DetailItem>
          <DetailItem label="24h change">
            <StatValue nowrap tone={changeTone}>
              {summary.change ?? "—"}
            </StatValue>
          </DetailItem>
          <DetailItem label="24h high">
            <StatValue nowrap>{summary.high ? `${summary.high} ${pool.quoteSymbol}` : "—"}</StatValue>
          </DetailItem>
          <DetailItem label="24h low">
            <StatValue nowrap>{summary.low ? `${summary.low} ${pool.quoteSymbol}` : "—"}</StatValue>
          </DetailItem>
          <DetailItem label="24h volume">
            <StatValue nowrap>{summary.volume ?? "—"}</StatValue>
          </DetailItem>
          <DetailItem label="Trading fee">
            <StatValue nowrap>
              {formatTradingFeeRate(pool.tradingFeeBps)} · {pool.tradingFeeBps} bps
            </StatValue>
          </DetailItem>
        </dl>
      </section>

      <section aria-labelledby="market-identifiers-heading" className="border-b border-border">
        <div className="px-4 pt-5 pb-2 sm:px-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider" id="market-identifiers-heading">
            Market identifiers
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Contracts open in {explorerUrl ? "the configured block explorer" : "an explorer when one is configured"}.
          </p>
        </div>
        <dl className="grid sm:grid-cols-2 xl:grid-cols-3 [&>*]:border-t [&>*]:border-border sm:[&>*:nth-child(odd)]:border-r xl:[&>*]:border-r xl:[&>*:nth-child(3n)]:border-r-0">
          <DetailItem label="Network">
            <span>{chainName}</span>
            {explorerUrl ? (
              <a
                className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={explorerUrl}
                rel="noreferrer"
                target="_blank"
              >
                Explorer
                <ExternalLink aria-hidden="true" className="size-3" strokeWidth={1.5} />
              </a>
            ) : null}
          </DetailItem>
          <DetailItem label="Market / pool ID">
            <span className="break-all font-mono text-xs tabular-nums">{pool.poolId}</span>
          </DetailItem>
          <DetailItem label="Pool / order book contract">
            <ExplorerLink address={pool.clobAddress} explorerUrl={explorerUrl} label="pool contract" />
          </DetailItem>
          <DetailItem label={`Base token · ${pool.baseSymbol}`}>
            <ExplorerLink address={pool.baseAsset} explorerUrl={explorerUrl} label={`${pool.baseSymbol} token`} />
          </DetailItem>
          <DetailItem label={`Quote token · ${pool.quoteSymbol}`}>
            <ExplorerLink address={pool.quoteAsset} explorerUrl={explorerUrl} label={`${pool.quoteSymbol} token`} />
          </DetailItem>
          <DetailItem label="Market registry">
            {factoryAddress ? (
              <ExplorerLink address={factoryAddress} explorerUrl={explorerUrl} label="market registry" />
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </DetailItem>
        </dl>
      </section>

      <section aria-labelledby="trading-parameters-heading">
        <div className="px-4 pt-5 pb-2 sm:px-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider" id="trading-parameters-heading">
            Trading parameters
          </h2>
        </div>
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4 [&>*]:border-t [&>*]:border-border sm:[&>*:nth-child(odd)]:border-r lg:[&>*]:border-r lg:[&>*:nth-child(4n)]:border-r-0">
          <DetailItem label="Minimum quantity">
            <StatValue>{minimumQuantity(pool)}</StatValue>
          </DetailItem>
          <DetailItem label="Minimum order value">
            <StatValue>{minimumOrderValue(pool)}</StatValue>
          </DetailItem>
          <DetailItem label="Price keys">
            <StatValue>{formatPriceKeyRange(pool)}</StatValue>
          </DetailItem>
          <DetailItem label="Price precision">
            <StatValue>{pricePrecision(pool)}</StatValue>
          </DetailItem>
          <DetailItem label="Minimum price">
            <StatValue>{priceRange(pool, "minimum")}</StatValue>
          </DetailItem>
          <DetailItem label="Maximum price">
            <StatValue>{priceRange(pool, "maximum")}</StatValue>
          </DetailItem>
          <DetailItem label="Token decimals">
            <StatValue>
              {pool.baseSymbol} {pool.baseDecimals} · {pool.quoteSymbol} {pool.quoteDecimals}
            </StatValue>
          </DetailItem>
          <DetailItem label="Pricing model">
            <span className="text-sm font-semibold">
              {pool.agnosticPricing ? "Decimal-agnostic · priceX18" : "Lot and tick based"}
            </span>
          </DetailItem>
        </dl>
      </section>
    </div>
  );
}
