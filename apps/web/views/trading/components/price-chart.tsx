"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TradeExecuted } from "@/lib/clob";

import type { MarketSummary } from "@/lib/trading/market-data";
import { aggregatePriceCandles, buildPriceCandles, compactNumber, type PriceCandle } from "@/lib/trading/market-stats";

type PriceChartProps = {
  summary: MarketSummary;
  candles?: PriceCandle[];
  trades?: TradeExecuted[];
  loading?: boolean;
  error?: string | null;
};

type HoveredCandle = {
  candle: PriceCandle;
  placeLeft: boolean;
  x: number;
};

const chartSurfaceClass =
  "min-w-0 overflow-hidden bg-background p-0 ring-[0.5px] ring-border dark:ring-border lg:min-h-[464px] lg:flex-1 lg:rounded-none lg:border-r-[0.5px] lg:border-border lg:ring-0";
const skeletonBarHeights = [24, 38, 31, 52, 45, 64, 48, 72, 58, 78, 68, 86, 73, 92, 81, 96];
const chartIntervals = [60, 15 * 60] as const;
// Lightweight Charts parses RGB colors internally, so these mirror the app's OKLCH theme tokens.
const chartPalettes = {
  light: {
    background: "rgb(249, 249, 249)",
    border: "rgba(10, 10, 10, 0.09)",
    down: "rgb(231, 0, 11)",
    downVolume: "rgba(231, 0, 11, 0.28)",
    foreground: "rgb(10, 10, 10)",
    muted: "rgb(115, 115, 115)",
    up: "rgb(0, 169, 121)",
    upVolume: "rgba(0, 169, 121, 0.32)",
  },
  dark: {
    background: "rgb(10, 10, 10)",
    border: "rgba(255, 255, 255, 0.07)",
    down: "rgb(255, 100, 103)",
    downVolume: "rgba(255, 100, 103, 0.34)",
    foreground: "rgb(251, 251, 251)",
    muted: "rgb(161, 161, 161)",
    up: "rgb(50, 202, 157)",
    upVolume: "rgba(50, 202, 157, 0.36)",
  },
} as const;

type ChartInterval = (typeof chartIntervals)[number];

function ChartSkeleton() {
  return (
    <Card aria-label="Loading price chart" className={chartSurfaceClass}>
      <div className="flex h-[520px] animate-pulse flex-col p-4 motion-reduce:animate-none sm:h-[640px] lg:h-full lg:min-h-[464px]">
        <div className="flex h-9 items-center gap-4 border-b border-border pb-3">
          <span className="h-2.5 w-10 rounded-full bg-muted" />
          <span className="h-2.5 w-16 rounded-full bg-muted" />
          <span className="h-2.5 w-20 rounded-full bg-muted" />
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="absolute inset-0 grid grid-rows-4 divide-y divide-border/70" />
          <div className="absolute inset-x-4 bottom-5 flex h-3/4 items-end gap-1.5">
            {skeletonBarHeights.map((height) => (
              <span className="min-w-1 flex-1 rounded-t-sm bg-muted" key={height} style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function EmptyChart({ error }: { error?: string | null }) {
  return (
    <Card className={chartSurfaceClass}>
      <div className="grid h-[520px] place-items-center px-6 text-center sm:h-[640px] lg:h-full lg:min-h-[464px]">
        <div>
          <p className="text-sm font-medium text-foreground">Chart not available</p>
          <p className="mt-1 max-w-sm text-pretty text-xs text-muted-foreground">
            {error ?? "Price history will appear after this market records its first trade."}
          </p>
        </div>
      </div>
    </Card>
  );
}

function formatTooltipTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1_000);
}

function timestampFromTime(time: Time) {
  if (typeof time === "number") return Number(time);
  if (typeof time === "string") return Math.floor(new Date(`${time}T00:00:00Z`).getTime() / 1_000);
  return Date.UTC(time.year, time.month - 1, time.day) / 1_000;
}

export function PriceChart({ summary, candles: indexedCandles, trades = [], loading = false, error }: PriceChartProps) {
  const [hovered, setHovered] = useState<HoveredCandle | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState<ChartInterval>(60);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candlestickSeriesRef = useRef<ReturnType<ReturnType<typeof createChart>["addSeries"]> | null>(null);
  const volumeSeriesRef = useRef<ReturnType<ReturnType<typeof createChart>["addSeries"]> | null>(null);
  const fittedIntervalRef = useRef<ChartInterval | null>(null);
  const { resolvedTheme } = useTheme();
  const derivedCandles = useMemo(() => indexedCandles ?? buildPriceCandles(trades), [indexedCandles, trades]);
  const intervalCandles = useMemo(
    () => (intervalSeconds === 60 ? derivedCandles : aggregatePriceCandles(derivedCandles, intervalSeconds)),
    [derivedCandles, intervalSeconds],
  );
  const latestCandle = intervalCandles.at(-1) ?? null;
  const displayCandle = hovered?.candle ?? latestCandle;
  const intervalLabel = intervalSeconds === 60 ? "1m" : "15m";
  const chartReady = Boolean(resolvedTheme) && !loading && !error && derivedCandles.length > 0;

  useEffect(() => {
    if (!chartReady) return;
    const container = chartContainerRef.current;
    if (!container) return;
    container.dataset.chartTheme = resolvedTheme ?? "system";

    const palette = resolvedTheme === "dark" ? chartPalettes.dark : chartPalettes.light;
    const fontFamily = getComputedStyle(container).fontFamily;
    const chart = createChart(container, {
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      layout: {
        attributionLogo: true,
        background: { type: ColorType.Solid, color: palette.background },
        fontFamily,
        textColor: palette.muted,
      },
      grid: {
        horzLines: { color: palette.border },
        vertLines: { color: palette.border },
      },
      localization: {
        priceFormatter: compactNumber,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: {
          color: palette.muted,
          labelBackgroundColor: palette.foreground,
          style: LineStyle.Dashed,
        },
        vertLine: {
          color: palette.muted,
          labelBackgroundColor: palette.foreground,
          style: LineStyle.Dashed,
        },
      },
      rightPriceScale: {
        borderColor: palette.border,
        mode: PriceScaleMode.Logarithmic,
        scaleMargins: { top: 0.16, bottom: 0.24 },
      },
      timeScale: {
        barSpacing: 9,
        borderColor: palette.border,
        minBarSpacing: 3,
        rightOffset: 4,
        secondsVisible: false,
        timeVisible: true,
      },
    });
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      borderVisible: false,
      downColor: palette.down,
      lastValueVisible: true,
      priceLineVisible: true,
      upColor: palette.up,
      wickDownColor: palette.down,
      wickUpColor: palette.up,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      lastValueVisible: false,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      priceScaleId: "",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    candlestickSeriesRef.current = candlestickSeries;
    chartRef.current = chart;
    volumeSeriesRef.current = volumeSeries;
    fittedIntervalRef.current = null;

    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = (param) => {
      const data = param.seriesData.get(candlestickSeries);
      if (!param.point || !param.time || !data || !("open" in data)) {
        setHovered(null);
        return;
      }
      setHovered({
        candle: {
          timestamp: timestampFromTime(param.time),
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          volume: 0,
        },
        placeLeft: param.point.x > container.clientWidth / 2,
        x: param.point.x,
      });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) chart.resize(width, height);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      delete container.dataset.chartTheme;
      chartRef.current = null;
      candlestickSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [chartReady, resolvedTheme]);

  useEffect(() => {
    if (!chartReady) return;
    const candlestickSeries = candlestickSeriesRef.current;
    const chart = chartRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candlestickSeries || !chart || !volumeSeries) return;

    const container = chartContainerRef.current;
    if (!container) return;
    container.dataset.chartTheme = resolvedTheme ?? "system";
    const palette = resolvedTheme === "dark" ? chartPalettes.dark : chartPalettes.light;
    candlestickSeries.setData(
      intervalCandles.map((candle) => ({
        time: candle.timestamp as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );
    volumeSeries.setData(
      intervalCandles.map((candle) => ({
        time: candle.timestamp as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? palette.upVolume : palette.downVolume,
      })),
    );

    if (fittedIntervalRef.current !== intervalSeconds && intervalCandles.length > 0) {
      const finalIndex = intervalCandles.length - 1;
      const visibleCandleCount = intervalSeconds === 60 ? 60 : 80;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, intervalCandles.length - visibleCandleCount),
        to: finalIndex + 4,
      });
      fittedIntervalRef.current = intervalSeconds;
    }
  }, [chartReady, intervalCandles, intervalSeconds, resolvedTheme]);

  if (loading) return <ChartSkeleton />;
  if (error || derivedCandles.length === 0) return <EmptyChart error={error} />;

  return (
    <Card className={chartSurfaceClass}>
      <div className="relative h-[520px] w-full font-sans sm:h-[640px] lg:h-full lg:min-h-[464px]">
        <div className="pointer-events-none absolute inset-x-[2.4%] top-3 z-20 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-[16px] font-medium text-foreground">{summary.symbol}</p>
            {displayCandle ? (
              <dl className="mt-1 flex flex-wrap gap-x-2.5 text-[10px] text-muted-foreground tabular-nums sm:text-[11px]">
                <div className="flex gap-1">
                  <dt>O</dt>
                  <dd className="text-foreground">{compactNumber(displayCandle.open)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>H</dt>
                  <dd className="text-foreground">{compactNumber(displayCandle.high)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>L</dt>
                  <dd className="text-foreground">{compactNumber(displayCandle.low)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>C</dt>
                  <dd className={displayCandle.close >= displayCandle.open ? "text-chart-3" : "text-destructive"}>
                    {compactNumber(displayCandle.close)}
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
          <Tabs
            className="pointer-events-auto shrink-0 gap-0"
            onValueChange={(value) => {
              setIntervalSeconds(value === "900" ? 15 * 60 : 60);
              setHovered(null);
            }}
            value={String(intervalSeconds)}
          >
            <TabsList
              aria-label="Chart interval"
              className="h-7 rounded-full bg-muted/70 ring-1 ring-border"
              indicatorClassName="rounded-full bg-background dark:border-transparent dark:bg-background"
            >
              {chartIntervals.map((interval) => (
                <TabsTrigger
                  className="h-6 min-w-8 rounded-full px-2 text-[11px] tabular-nums"
                  key={interval}
                  value={String(interval)}
                >
                  {interval === 60 ? "1m" : "15m"}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {hovered ? (
          <div
            className="pointer-events-none absolute top-20 z-20 min-w-52 rounded-lg bg-popover px-3 py-2.5 text-popover-foreground shadow-lg ring-1 ring-border"
            role="tooltip"
            style={{
              left: hovered.x,
              transform: hovered.placeLeft ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            }}
          >
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {formatTooltipTime(hovered.candle.timestamp)}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs tabular-nums">
              <dt className="text-muted-foreground">Open</dt>
              <dd className="text-right font-medium">{compactNumber(hovered.candle.open)}</dd>
              <dt className="text-muted-foreground">High</dt>
              <dd className="text-right font-medium">{compactNumber(hovered.candle.high)}</dd>
              <dt className="text-muted-foreground">Low</dt>
              <dd className="text-right font-medium">{compactNumber(hovered.candle.low)}</dd>
              <dt className="text-muted-foreground">Close</dt>
              <dd className="text-right font-medium">{compactNumber(hovered.candle.close)}</dd>
            </dl>
          </div>
        ) : null}

        <p className="sr-only">
          {`${summary.symbol} ${intervalLabel} candlestick chart with ${intervalCandles.length} candles.`}
        </p>
        <div className="absolute inset-0" ref={chartContainerRef} />
      </div>
    </Card>
  );
}
