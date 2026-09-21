"use client";

import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RangeSlider } from "@/components/motion/range-slider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { validateOrderBalance } from "@/lib/clob/order-validation";
import { sanitizeDecimalInput } from "@/lib/forms/numeric-input";

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
  mobileCompact?: boolean;
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
  mobileCompact = false,
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
        timeout: 0,
        title: "Transaction submitted.",
        type: "loading",
      });
      return;
    }

    if (transaction.status === "success") {
      const completionKey = transaction.hash ?? transaction.message ?? "success";
      if (completedTransaction.current === completionKey) return;

      completedTransaction.current = completionKey;
      showToast({
        description: transactionDescription,
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
    <Card
      className={`min-w-0 gap-0 py-0 ring-[0.5px] ring-border dark:ring-border lg:flex-1 lg:rounded-none lg:border-l-[0.5px] lg:border-border lg:bg-background lg:ring-0 ${
        mobileCompact ? "rounded-none bg-background ring-0" : ""
      }`}
    >
      <CardHeader className="px-0 pt-0 !pb-0">
        <Tabs className="gap-0" onValueChange={(value) => selectOrderType(value as OrderType)} value={orderType}>
          <TabsList
            aria-label="Order type"
            className={`w-full justify-start gap-0 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 ${
              mobileCompact ? "h-10! lg:h-12!" : "h-12!"
            }`}
            indicatorClassName="rounded-none border-0 bg-transparent after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary after:content-[''] dark:bg-transparent"
          >
            {(["market", "limit"] as const).map((type) => (
              <TabsTrigger
                className={`h-full flex-none shrink-0 rounded-none text-xs capitalize data-active:text-foreground ${
                  mobileCompact ? "px-2 lg:px-4" : "px-4"
                }`}
                key={type}
                value={type}
              >
                {type}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent
        className={`flex flex-1 flex-col ${
          mobileCompact
            ? "gap-2 px-2 pb-2 pt-2 sm:px-2 sm:pb-2 sm:pt-2 lg:gap-4 lg:px-4 lg:pb-4 lg:pt-3"
            : "gap-4 px-4 pb-4 pt-3 sm:px-5 sm:pb-5 sm:pt-3"
        }`}
      >
        <Tabs className="w-full" onValueChange={(value) => selectSide(value as OrderSide)} value={side}>
          <TabsList
            aria-label="Trade side"
            className={`grid h-auto! w-full grid-cols-2 rounded-full bg-secondary px-1 py-1 ${mobileCompact ? "lg:px-1 lg:py-1" : ""}`}
            indicatorClassName="rounded-full bg-background dark:bg-background"
          >
            <TabsTrigger className="w-full rounded-full py-1.5 text-xs data-active:text-chart-3" value="buy">
              <span className={mobileCompact ? "lg:hidden" : "hidden"}>Buy</span>
              <span className={mobileCompact ? "hidden lg:inline" : "inline"}>Buy {summary.baseAsset}</span>
            </TabsTrigger>
            <TabsTrigger className="w-full rounded-full py-1.5 text-xs data-active:text-destructive" value="sell">
              <span className={mobileCompact ? "lg:hidden" : "hidden"}>Sell</span>
              <span className={mobileCompact ? "hidden lg:inline" : "inline"}>Sell {summary.baseAsset}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div
          className={`flex items-center justify-between gap-2 border-b border-border ${mobileCompact ? "pb-1" : "pb-2"}`}
        >
          <p
            className={`${mobileCompact ? "text-[10px] lg:text-xs" : "text-xs"} font-medium text-muted-foreground underline decoration-dashed underline-offset-4`}
          >
            <span className={mobileCompact ? "lg:hidden" : "hidden"}>Available</span>
            <span className={mobileCompact ? "hidden lg:inline" : "inline"}>Available in wallet</span>
          </p>
          <span
            className={`${mobileCompact ? "text-xs lg:text-sm" : "text-sm"} truncate font-mono tabular-nums text-foreground`}
          >
            {balance ? `${formatCurrencyAmount(balance.free)} ${balance.symbol}` : "0.00"}
          </span>
        </div>
        <FieldGroup className={mobileCompact ? "gap-2 lg:gap-3" : "gap-3"}>
          {orderType === "limit" ? (
            <Field className={mobileCompact ? "gap-1 lg:gap-1.5" : "gap-1.5"}>
              <FieldLabel
                className={
                  mobileCompact ? "text-[10px] text-muted-foreground lg:text-xs" : "text-xs text-muted-foreground"
                }
                htmlFor="order-price"
              >
                Price
              </FieldLabel>
              <span className="relative">
                <Input
                  autoComplete="off"
                  autoCorrect="off"
                  className={
                    mobileCompact
                      ? "h-9 rounded-lg border-input bg-background px-2 pr-10 text-xs font-mono tabular-nums lg:h-11 lg:rounded-xl lg:px-3 lg:pr-16 lg:text-sm"
                      : "h-11 rounded-xl border-input bg-background px-3 pr-16 font-mono tabular-nums"
                  }
                  id="order-price"
                  inputMode="decimal"
                  onChange={(event) => {
                    const nextPrice = sanitizeDecimalInput(event.target.value);
                    setPrice(nextPrice);
                    setAllocation(allocationForAmount(amount, nextPrice));
                  }}
                  spellCheck={false}
                  value={price}
                />
                <span
                  className={`pointer-events-none absolute inset-y-0 inline-flex items-center font-mono text-[10px] text-muted-foreground ${mobileCompact ? "right-2 lg:right-3" : "right-3"}`}
                >
                  {summary.quoteAsset}
                </span>
              </span>
            </Field>
          ) : null}
          <Field className={mobileCompact ? "gap-1 lg:gap-1.5" : "gap-1.5"}>
            <FieldLabel
              className={
                mobileCompact ? "text-[10px] text-muted-foreground lg:text-xs" : "text-xs text-muted-foreground"
              }
              htmlFor="order-amount"
            >
              Size
            </FieldLabel>
            <span className="relative">
              <Input
                aria-invalid={Boolean(balanceError)}
                autoComplete="off"
                autoCorrect="off"
                className={
                  mobileCompact
                    ? "h-9 rounded-lg border-input bg-background px-2 pr-10 text-xs font-mono tabular-nums lg:h-11 lg:rounded-xl lg:px-3 lg:pr-16 lg:text-sm"
                    : "h-11 rounded-xl border-input bg-background px-3 pr-16 font-mono tabular-nums"
                }
                id="order-amount"
                inputMode="decimal"
                onChange={(event) => {
                  const nextAmount = sanitizeDecimalInput(event.target.value);
                  setAmount(nextAmount);
                  setAllocation(allocationForAmount(nextAmount));
                }}
                placeholder="0.00"
                spellCheck={false}
                value={amount}
              />
              <span
                className={`pointer-events-none absolute inset-y-0 inline-flex items-center font-mono text-[10px] text-muted-foreground ${mobileCompact ? "right-2 lg:right-3" : "right-3"}`}
              >
                {summary.baseAsset}
              </span>
            </span>
          </Field>
        </FieldGroup>
        <div className={`flex items-center ${mobileCompact ? "gap-2 lg:gap-3" : "gap-3"}`}>
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
          <output
            className={`grid h-8 place-items-center rounded-lg border border-input bg-background font-mono text-xs tabular-nums text-foreground ${mobileCompact ? "min-w-11 px-1 lg:min-w-16 lg:px-2" : "min-w-16 px-2"}`}
          >
            {allocation}%
          </output>
        </div>
        <div
          className={`flex flex-col border-t border-border text-xs ${mobileCompact ? "gap-1 pt-2 text-[10px] lg:gap-2 lg:pt-4 lg:text-xs" : "gap-2 pt-4"}`}
        >
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>Estimated total</span>
            <span className="font-mono tabular-nums text-foreground">
              {estimatedTotal ? `${estimatedTotal} ${summary.quoteAsset}` : "—"}
            </span>
          </div>
          <div className="flex justify-between gap-3 text-muted-foreground">
            <span>Fee</span>
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
          className={`relative h-auto w-full rounded-full text-xs font-semibold after:absolute after:inset-x-0 after:top-1/2 after:h-10 after:-translate-y-1/2 active:scale-[0.96] ${mobileCompact ? "py-1.5 lg:py-2" : "py-2"}`}
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
                : mobileCompact
                  ? "Connect"
                  : "Connect wallet to trade"}
          </span>
        </Button>
      </CardContent>
    </Card>
  );
}
