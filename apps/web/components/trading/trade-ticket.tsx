"use client";

import { ChevronDown, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RangeSlider } from "@/components/motion/range-slider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { validateOrderBalance } from "@/lib/clob/order-validation";

import type { Balance, MarketSummary, OrderSide, OrderType, TransactionFeedback } from "./market-data";
import { formatCurrencyAmount } from "./market-details-formatting";
import { deriveAllocationPercentage } from "./trade-ticket-allocation";
import { formatTradingFeeRate } from "./trade-ticket-fee";

function clean(value: string) {
  return value.replaceAll(",", "").trim();
}

function decimalParts(value: string) {
  const [integer = "0", fraction = ""] = clean(value).split(".");
  return { integer: integer.replace(/^0+(?=\d)/, "") || "0", fraction };
}

function multiplyDecimal(left: string, right: string, fractionDigits = 2) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (
    !/^\d+$/.test(a.integer) ||
    !/^\d+$/.test(b.integer) ||
    (a.fraction && !/^\d+$/.test(a.fraction)) ||
    (b.fraction && !/^\d+$/.test(b.fraction))
  )
    return null;
  const scale = a.fraction.length + b.fraction.length;
  const raw = BigInt(`${a.integer}${a.fraction}`) * BigInt(`${b.integer}${b.fraction}`);
  if (raw === 0n) return "0";
  const divisor = 10n ** BigInt(scale);
  const rounded = (raw * 10n ** BigInt(fractionDigits) + divisor / 2n) / divisor;
  const whole = rounded / 10n ** BigInt(fractionDigits);
  const fraction = (rounded % 10n ** BigInt(fractionDigits)).toString().padStart(fractionDigits, "0");
  return `${whole}.${fraction}`;
}

function percentageOf(value: string, percentage: number) {
  const { integer, fraction } = decimalParts(value);
  if (!/^\d+$/.test(integer) || (fraction && !/^\d+$/.test(fraction))) return "";
  const digits = fraction.length;
  const scale = 10n ** BigInt(digits);
  const raw = BigInt(`${integer}${fraction || ""}`);
  const percent = BigInt(Math.round(percentage * 100));
  const result = (raw * percent) / 10_000n;
  const whole = result / scale;
  const remainder = (result % scale).toString().padStart(digits, "0").replace(/0+$/, "");
  return remainder ? `${whole}.${remainder}` : whole.toString();
}

function divideDecimal(left: string, right: string, fractionDigits = 8) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (
    !/^\d+$/.test(a.integer) ||
    !/^\d+$/.test(b.integer) ||
    (a.fraction && !/^\d+$/.test(a.fraction)) ||
    (b.fraction && !/^\d+$/.test(b.fraction))
  )
    return "";
  const leftRaw = BigInt(`${a.integer}${a.fraction || ""}`);
  const rightRaw = BigInt(`${b.integer}${b.fraction || ""}`);
  if (rightRaw === 0n) return "";
  const numerator = leftRaw * 10n ** BigInt(b.fraction.length + fractionDigits);
  const denominator = rightRaw * 10n ** BigInt(a.fraction.length);
  const result = numerator / denominator;
  const scale = 10n ** BigInt(fractionDigits);
  const whole = result / scale;
  const remainder = (result % scale).toString().padStart(fractionDigits, "0").replace(/0+$/, "");
  return remainder ? `${whole}.${remainder}` : whole.toString();
}

type TradeTicketProps = {
  summary: MarketSummary;
  quoteBalance: Balance | null;
  baseBalance: Balance | null;
  explorerUrl?: string;
  side: OrderSide;
  connected: boolean;
  ready: boolean;
  transaction: TransactionFeedback;
  tradingFeeBps: number | null;
  marketPrice: string | null;
  selectedOrder: { price: string; size: string } | null;
  onLimitOrder: (input: { side: OrderSide; price: string; quantity: string }) => Promise<void>;
  onMarketOrder: (input: { side: OrderSide; quantity: string }) => Promise<void>;
  onSideChange: (side: OrderSide) => void;
  onConnect?: () => void;
};

export function TradeTicket({
  summary,
  quoteBalance,
  baseBalance,
  explorerUrl,
  side,
  connected,
  ready,
  transaction,
  tradingFeeBps,
  marketPrice,
  selectedOrder,
  onLimitOrder,
  onMarketOrder,
  onSideChange,
  onConnect,
}: TradeTicketProps) {
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [price, setPrice] = useState(summary.price ?? "");
  const [amount, setAmount] = useState("");
  const [allocation, setAllocation] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const transactionToastId = useRef<string | null>(null);
  const completedTransaction = useRef<string | null>(null);
  const isBuy = side === "buy";
  const balance = isBuy ? quoteBalance : baseBalance;
  const effectivePrice = orderType === "market" ? marketPrice || summary.price || "" : price || summary.price || "";
  const estimatedTotal = useMemo(
    () => (orderType === "market" ? "Market execution" : amount && price ? multiplyDecimal(amount, price) : null),
    [amount, orderType, price],
  );
  const balanceError = useMemo(() => {
    if (!balance || !amount) return null;
    return validateOrderBalance({
      side,
      orderType,
      amount,
      price: effectivePrice,
      available: balance.free,
      symbol: balance.symbol,
    });
  }, [amount, balance, effectivePrice, orderType, side]);
  const submitting = transaction.status === "pending";
  const canSubmit =
    ready &&
    !submitting &&
    (!connected ||
      (Boolean(balance) && Boolean(amount) && (orderType === "market" || Boolean(price)) && !balanceError));

  function allocationForAmount(nextAmount: string, nextPrice = price) {
    if (!balance) return 0;
    return deriveAllocationPercentage({
      amount: nextAmount,
      available: balance.free,
      isBuy,
      price: orderType === "market" ? effectivePrice : nextPrice || summary.price || "",
    });
  }

  useEffect(() => {
    if (!selectedOrder) return;
    setOrderType("limit");
    setPrice(selectedOrder.price);
    setAmount(selectedOrder.size);
    setAllocation(0);
    setFormError(null);
  }, [selectedOrder]);

  useEffect(() => {
    const transactionDescription = transaction.hash ? (
      explorerUrl ? (
        <a
          className="inline-flex items-center gap-1 font-mono underline underline-offset-4 hover:text-foreground"
          href={`${explorerUrl}/tx/${transaction.hash}`}
          rel="noreferrer"
          target="_blank"
          title={transaction.hash}
        >
          {`${transaction.hash.slice(0, 10)}…${transaction.hash.slice(-8)}`}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : (
        <span className="font-mono">{`${transaction.hash.slice(0, 10)}…${transaction.hash.slice(-8)}`}</span>
      )
    ) : null;
    const showToast = (options: Parameters<typeof toast.add>[0]) => {
      transactionToastId.current = toast.add({
        id: transactionToastId.current ?? undefined,
        ...options,
      });
    };

    if (transaction.status === "pending") {
      completedTransaction.current = null;
      showToast({
        description: "Preparing your on-chain transaction.",
        timeout: 0,
        title: "Submitting transaction…",
        type: "loading",
      });
      return;
    }

    if (transaction.status === "submitted") {
      showToast({
        description: transactionDescription ?? "Waiting for on-chain confirmation.",
        timeout: 0,
        title: transaction.message ?? "Transaction submitted.",
        type: "loading",
      });
      return;
    }

    if (transaction.status === "success") {
      const completionKey = transaction.hash ?? transaction.message ?? "success";
      if (completedTransaction.current === completionKey) return;

      completedTransaction.current = completionKey;
      showToast({
        timeout: 8_000,
        title: transaction.message ?? "Transaction submitted.",
        type: "success",
      });
      transactionToastId.current = null;
      return;
    }

    if (transaction.status === "error" && transaction.message) {
      showToast({
        timeout: 8_000,
        title: transaction.message,
        type: "error",
      });
      transactionToastId.current = null;
    }
  }, [explorerUrl, transaction.hash, transaction.message, transaction.status]);

  useEffect(
    () => () => {
      if (transactionToastId.current) toast.close(transactionToastId.current);
    },
    [],
  );

  function selectOrderType(nextType: OrderType) {
    setOrderType(nextType);
    setAllocation(0);
    setAmount("");
  }

  function selectSide(nextSide: OrderSide) {
    onSideChange(nextSide);
    setAllocation(0);
    setAmount("");
  }

  function applyAllocation(nextAllocation: number) {
    setAllocation(nextAllocation);
    if (!balance || nextAllocation === 0) {
      setAmount("");
      return;
    }
    const available = percentageOf(balance.free, nextAllocation / 100);
    setAmount(isBuy ? divideDecimal(available, effectivePrice) : available);
  }

  async function submit() {
    setFormError(null);
    if (!connected) return setFormError("Connect your wallet to trade.");
    if (!balance) return setFormError("Balance data is unavailable.");
    if (!amount || (orderType === "limit" && !price)) return setFormError("Enter a price and amount.");
    const validationError = validateOrderBalance({
      side,
      orderType,
      amount,
      price: effectivePrice,
      available: balance.free,
      symbol: balance.symbol,
    });
    if (validationError) return setFormError(validationError);
    try {
      if (orderType === "market") await onMarketOrder({ side, quantity: amount });
      else await onLimitOrder({ side, price, quantity: amount });
      setAmount("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Transaction could not be submitted.");
    }
  }

  return (
    <Card className="gap-0 py-0 ring-[0.5px] ring-border dark:ring-border lg:flex-1 lg:rounded-none lg:border-l-[0.5px] lg:border-border lg:bg-background lg:ring-0">
      <CardHeader className="px-0 pt-0 !pb-0">
        <Tabs className="gap-0" onValueChange={(value) => selectOrderType(value as OrderType)} value={orderType}>
          <TabsList
            aria-label="Order type"
            className="h-12! w-full justify-start gap-0 overflow-x-auto rounded-none border-b border-border bg-transparent p-0"
            indicatorClassName="rounded-none border-0 bg-transparent after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary after:content-[''] dark:bg-transparent"
          >
            {(["market", "limit"] as const).map((type) => (
              <TabsTrigger
                className="h-full flex-none shrink-0 rounded-none px-4 text-xs capitalize data-active:text-foreground"
                key={type}
                value={type}
              >
                {type}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5 sm:pt-3">
        <Tabs className="w-full" onValueChange={(value) => selectSide(value as OrderSide)} value={side}>
          <TabsList
            aria-label="Trade side"
            className="grid h-auto! w-full grid-cols-2 rounded-full bg-secondary px-1 py-1"
            indicatorClassName="rounded-full bg-background dark:bg-background"
          >
            <TabsTrigger className="w-full rounded-full py-1.5 text-xs data-active:text-chart-3" value="buy">
              Buy {summary.baseAsset}
            </TabsTrigger>
            <TabsTrigger className="w-full rounded-full py-1.5 text-xs data-active:text-destructive" value="sell">
              Sell {summary.baseAsset}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
          <p className="text-xs font-medium text-muted-foreground underline decoration-dashed underline-offset-4">
            Available in wallet
          </p>
          <span className="font-mono text-sm tabular-nums text-foreground">
            {balance ? `${formatCurrencyAmount(balance.free)} ${balance.symbol}` : "Unavailable"}
          </span>
        </div>
        <FieldGroup className="gap-3">
          {orderType === "limit" ? (
            <Field className="gap-1.5">
              <FieldLabel className="text-xs text-muted-foreground" htmlFor="order-price">
                Price
              </FieldLabel>
              <span className="relative">
                <Input
                  className="h-11 rounded-xl border-input bg-background px-3 pr-16 font-mono tabular-nums"
                  id="order-price"
                  inputMode="decimal"
                  onChange={(event) => {
                    const nextPrice = event.target.value;
                    setPrice(nextPrice);
                    setAllocation(allocationForAmount(amount, nextPrice));
                  }}
                  value={price}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 inline-flex items-center font-mono text-[10px] text-muted-foreground">
                  {summary.quoteAsset}
                </span>
              </span>
            </Field>
          ) : null}
          <Field className="gap-1.5">
            <FieldLabel className="text-xs text-muted-foreground" htmlFor="order-amount">
              Size
            </FieldLabel>
            <span className="relative">
              <Input
                aria-invalid={Boolean(balanceError)}
                className="h-11 rounded-xl border-input bg-background px-3 pr-16 font-mono tabular-nums"
                id="order-amount"
                inputMode="decimal"
                onChange={(event) => {
                  const nextAmount = event.target.value;
                  setAmount(nextAmount);
                  setAllocation(allocationForAmount(nextAmount));
                }}
                placeholder="0.00"
                value={amount}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 inline-flex items-center font-mono text-[10px] text-muted-foreground">
                {summary.baseAsset}
              </span>
            </span>
          </Field>
        </FieldGroup>
        <div className="flex items-center gap-3">
          <RangeSlider
            aria-label="Order size percentage"
            className="min-w-0 flex-1"
            disabled={!balance || (isBuy && !effectivePrice)}
            formatValueText={(value) => `${value}% of available balance`}
            max={100}
            min={0}
            onValueChange={applyAllocation}
            step={25}
            value={allocation}
          />
          <output className="grid h-8 min-w-16 place-items-center rounded-lg border border-input bg-background px-2 font-mono text-xs tabular-nums text-foreground">
            {allocation}%
          </output>
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-4 text-xs">
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>Estimated total</span>
            <span className="font-mono tabular-nums text-foreground">
              {estimatedTotal ? `${estimatedTotal} ${summary.quoteAsset}` : "—"}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              Fee <ChevronDown aria-hidden="true" className="size-3" />
            </span>
            <span className="font-mono tabular-nums">
              {tradingFeeBps === null ? "—" : formatTradingFeeRate(tradingFeeBps)}
            </span>
          </div>
        </div>
        {balanceError ? (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {balanceError}
          </p>
        ) : null}
        {formError && formError !== transaction.message ? (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {formError}
          </p>
        ) : null}
        {transaction.status === "error" && transaction.message && !balanceError ? (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {transaction.message}
          </p>
        ) : null}
        <Button
          className="relative h-auto w-full rounded-full py-2 text-xs font-semibold after:absolute after:inset-x-0 after:top-1/2 after:h-10 after:-translate-y-1/2 active:scale-[0.96]"
          disabled={!canSubmit}
          onClick={() => {
            if (!connected) onConnect?.();
            else void submit();
          }}
          size="sm"
          type="button"
          variant={connected ? (isBuy ? "buy" : "sell") : "default"}
        >
          {submitting ? <LoaderCircle aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : null}
          <span className={connected ? "text-white" : undefined}>
            {submitting
              ? "Submitting…"
              : connected
                ? isBuy
                  ? `Place buy order`
                  : `Place sell order`
                : "Connect wallet to trade"}
          </span>
        </Button>
      </CardContent>
    </Card>
  );
}
