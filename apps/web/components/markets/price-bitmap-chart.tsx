"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const tickStops = [
  { label: "1", power: 0 },
  { label: "2³²", power: 32 },
  { label: "2⁶⁴", power: 64 },
  { label: "2⁹⁶", power: 96 },
  { label: "2¹²⁸−1", power: 128 },
] as const;
const bitmapBuckets = Array.from({ length: 16 }, (_, index) => index + 1);
const segmentsPerBucket = 2;
const bucketSegments = ["lower", "upper"] as const;
const visualBarCount = bitmapBuckets.length * segmentsPerBucket;
const plotLeft = 34;
const plotWidth = 612;
const barGap = 2;
const barWidth = (plotWidth - barGap * (visualBarCount - 1)) / visualBarCount;

function barGeometry(index: number) {
  const height = 96 + (index / (visualBarCount - 1)) * 69;
  return {
    height,
    x: plotLeft + index * (barWidth + barGap),
    y: 185 - height,
  };
}

function compactPrice(value: string) {
  const number = Number(value);

  if (!Number.isFinite(number) || number === 0) return value;
  if (Math.abs(number) >= 1_000_000 || Math.abs(number) < 0.001) {
    return number.toExponential(2);
  }

  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(number);
}

function BitmapConfigItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-background p-4">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 break-words font-mono text-sm font-semibold tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

export function PriceBitmapChart({
  loading,
  maximumPrice,
  minimumTrade,
  minimumOrderValue,
  minimumPrice,
  quoteSymbol,
  tickSize,
}: {
  loading?: boolean;
  maximumPrice?: string;
  minimumTrade: string;
  minimumOrderValue: string;
  minimumPrice?: string;
  quoteSymbol: string;
  tickSize: string;
}) {
  const [activeBucket, setActiveBucket] = useState<number | null>(null);

  return (
    <Card className="min-h-full flex-1 overflow-hidden rounded-none bg-background py-0 ring-0">
      <CardHeader className="!flex flex-row !items-center gap-3 whitespace-nowrap border-b border-border py-4">
        <CardTitle className="shrink-0 text-lg">Create New Spot market</CardTitle>
        <p className="min-w-0 truncate text-xs text-muted-foreground">Sparse radix coverage</p>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          128-bit range
        </span>
      </CardHeader>
      <CardContent className="flex min-h-72 flex-1 flex-col p-0">
        <div className="flex min-h-0 flex-1 flex-col gap-6 px-5 py-4">
          <div className="grid grid-cols-2 overflow-hidden rounded-xl">
            <div className="min-w-0 border-r border-border px-4 py-3">
              <p className="text-[11px] font-medium text-muted-foreground">Minimum token price</p>
              <p className="mt-1.5 truncate font-mono text-sm font-semibold tabular-nums" title={minimumPrice}>
                {minimumPrice ? `${compactPrice(minimumPrice)} ${quoteSymbol}` : "—"}
              </p>
            </div>
            <div className="min-w-0 px-4 py-3 text-right">
              <p className="text-[11px] font-medium text-muted-foreground">Maximum token price</p>
              <p className="mt-1.5 truncate font-mono text-sm font-semibold tabular-nums" title={maximumPrice}>
                {maximumPrice ? `${compactPrice(maximumPrice)} ${quoteSymbol}` : "—"}
              </p>
            </div>
          </div>

          <figure aria-label="Supported uint128 price range" className="flex min-w-0 flex-1 flex-col justify-end">
            <svg className="h-auto w-full" role="img" viewBox="0 0 680 250">
              <title>Supported price range from 1 to uint128 maximum in priceX18 units</title>
              <desc>
                A sparse 128-bit radix price index divided into 16 bytes. Actual prices become available after both
                tokens verify.
              </desc>
              <g>
                {tickStops.map((stop) => {
                  const x = 34 + (stop.power / 128) * 612;
                  return (
                    <line
                      className="stroke-border"
                      key={stop.power}
                      strokeDasharray="4 6"
                      x1={x}
                      x2={x}
                      y1="20"
                      y2="192"
                    />
                  );
                })}

                {bitmapBuckets.map((bucket) => (
                  /* biome-ignore lint/a11y/useSemanticElements: SVG chart buckets cannot be represented by HTML button elements. */
                  <g
                    aria-describedby={activeBucket === bucket ? `bitmap-tooltip-${bucket}` : undefined}
                    aria-label={`Radix byte ${bucket} of 16`}
                    aria-pressed={activeBucket === bucket}
                    className="cursor-help outline-none"
                    key={bucket}
                    onBlur={() => setActiveBucket(null)}
                    onClick={() => setActiveBucket(bucket)}
                    onFocus={() => setActiveBucket(bucket)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveBucket(bucket);
                      }
                    }}
                    onMouseEnter={() => setActiveBucket(bucket)}
                    onMouseLeave={() => setActiveBucket(null)}
                    role="button"
                    tabIndex={0}
                  >
                    {bucketSegments.map((segment, segmentIndex) => {
                      const visualIndex = (bucket - 1) * segmentsPerBucket + segmentIndex;
                      const { height, x, y } = barGeometry(visualIndex);
                      return (
                        <rect
                          className={activeBucket === bucket ? "fill-chart-3" : "fill-secondary"}
                          height={height}
                          key={segment}
                          rx="2"
                          width={barWidth}
                          x={x}
                          y={y}
                        />
                      );
                    })}
                  </g>
                ))}

                {activeBucket ? (
                  <g className="pointer-events-none" id={`bitmap-tooltip-${activeBucket}`}>
                    <rect
                      className="fill-popover stroke-border"
                      height="22"
                      rx="4"
                      strokeWidth="0.5"
                      width="118"
                      x={Math.min(
                        528,
                        Math.max(
                          34,
                          barGeometry((activeBucket - 1) * segmentsPerBucket).x + barWidth + barGap / 2 - 59,
                        ),
                      )}
                      y={Math.max(3, barGeometry(activeBucket * segmentsPerBucket - 1).y + 7)}
                    />
                    <text
                      className="fill-popover-foreground font-mono text-[7px] tabular-nums"
                      textAnchor="middle"
                      x={Math.min(
                        587,
                        Math.max(93, barGeometry((activeBucket - 1) * segmentsPerBucket).x + barWidth + barGap / 2),
                      )}
                      y={Math.max(17, barGeometry(activeBucket * segmentsPerBucket - 1).y + 21)}
                    >
                      {`Radix byte ${activeBucket} of 16`}
                    </text>
                  </g>
                ) : null}

                <line className="stroke-foreground/25" x1="34" x2="646" y1="193" y2="193" />
                {tickStops.map((stop) => {
                  const x = 34 + (stop.power / 128) * 612;
                  const anchor = stop.power === 0 ? "start" : stop.power === 128 ? "end" : "middle";
                  return (
                    <g key={stop.power}>
                      <circle className="fill-background stroke-foreground" cx={x} cy="193" r="4" strokeWidth="2" />
                      <text
                        className="fill-muted-foreground font-mono text-[11px] tabular-nums"
                        textAnchor={anchor}
                        x={x}
                        y="220"
                      >
                        {stop.label}
                      </text>
                    </g>
                  );
                })}
                <text className="fill-muted-foreground text-[10px]" textAnchor="middle" x="340" y="244">
                  uint128 priceX18 · logarithmic coverage
                </text>
              </g>
            </svg>
            <figcaption
              aria-live="polite"
              className="mt-1 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
            >
              <span
                aria-hidden={!loading}
                className={loading ? "flex items-center gap-2" : "invisible flex items-center gap-2"}
              >
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
                Calculating pair range…
              </span>
            </figcaption>
          </figure>
        </div>

        <dl className="grid border-t-[0.5px] border-border sm:grid-cols-2 [&>*]:border-b-[0.5px] [&>*]:border-border [&>*:last-child]:border-b-0 sm:[&>*:nth-child(n+3)]:border-b-0 sm:[&>*:nth-child(odd)]:border-r-[0.5px]">
          <BitmapConfigItem label="Minimum quantity" value={minimumTrade} />
          <BitmapConfigItem label="Minimum order value" value={minimumOrderValue} />
          <BitmapConfigItem label="Price keys" value="1–2¹²⁸−1" />
          <BitmapConfigItem label="Price precision" value={tickSize} />
        </dl>
      </CardContent>
    </Card>
  );
}
