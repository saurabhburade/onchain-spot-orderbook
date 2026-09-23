"use client";

import { ArrowLeftRight, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, type ReactNode, useEffect, useMemo, useState } from "react";
import { formatUnits, getAddress, isAddress } from "viem";
import { TokenIcon } from "@/components/token-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  type CreateMarketInput,
  formatFraction,
  listedQuoteTokens,
  type MarketToken,
  type PoolId,
  poolRegistryAbi,
  useClobChain,
  useCreateMarket,
} from "@/lib/clob";
import { listedTokenIconUrl } from "@/lib/clob/market-list";
import { PriceBitmapChart } from "@/views/markets/components/price-bitmap-chart";

type PairInfo = { base: MarketToken; quote: MarketToken; legacyFactory: boolean; existingPoolId?: PoolId };

type TokenVerification =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "valid"; token: MarketToken }
  | { status: "error"; message: string };

const maxUint128 = (1n << 128n) - 1n;
const priceScale = 10n ** 18n;

function TokenReviewIcon({ compact = false, symbol, url }: { compact?: boolean; symbol: string; url?: string }) {
  return (
    <TokenIcon
      alt={`${symbol} token icon`}
      className={`bg-background ${compact ? "size-10" : "size-24"}`}
      fallbackClassName={compact ? "size-5" : "size-10"}
      sizes={compact ? "40px" : "96px"}
      url={url}
    />
  );
}

function ConfigItem({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="min-w-0 bg-background p-4 dark:bg-popover">
      <dt className="text-[11px] font-medium normal-case text-muted-foreground">{label}</dt>
      <dd className={`mt-1.5 break-words text-sm font-semibold ${mono ? "font-mono tabular-nums" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

function useTokenVerification(
  input: string,
  inspectToken: (address: string) => Promise<MarketToken>,
  isQuoteTokenApproved?: (address: string) => Promise<boolean>,
) {
  const [verification, setVerification] = useState<TokenVerification>({ status: "idle" });

  useEffect(() => {
    const address = input.trim();
    if (!address) {
      setVerification({ status: "idle" });
      return;
    }
    if (!isAddress(address)) {
      setVerification(
        address.length >= 42 ? { status: "error", message: "Enter a valid 0x token address" } : { status: "idle" },
      );
      return;
    }

    let active = true;
    setVerification({ status: "checking" });
    void (async () => {
      try {
        const [token, quoteApproved] = await Promise.all([
          inspectToken(address),
          isQuoteTokenApproved ? isQuoteTokenApproved(address) : Promise.resolve(true),
        ]);
        if (!quoteApproved) throw new Error("This token is not approved for quoting markets");
        if (active) setVerification({ status: "valid", token });
      } catch (error) {
        if (active)
          setVerification({
            status: "error",
            message: error instanceof Error ? error.message : "Token verification failed",
          });
      }
    })();

    return () => {
      active = false;
    };
  }, [input, inspectToken, isQuoteTokenApproved]);

  return verification;
}

function TokenVerificationIndicator({
  chainName,
  id,
  quote,
  verification,
}: {
  chainName: string;
  id: string;
  quote?: boolean;
  verification: TokenVerification;
}) {
  if (verification.status === "idle") return null;

  const message =
    verification.status === "checking"
      ? `Verifying on ${chainName}…`
      : verification.status === "valid"
        ? `Verified on ${chainName}${quote ? " · Approved quote" : ""}`
        : verification.message;
  const tooltipId = `${id}-verification-tooltip`;

  return (
    <span className="group absolute inset-y-0 right-2 flex items-center">
      <button
        aria-describedby={tooltipId}
        aria-label={message}
        className="grid size-10 cursor-help place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        type="button"
      >
        {verification.status === "checking" ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
            strokeWidth={1.5}
          />
        ) : verification.status === "valid" ? (
          <CircleCheck aria-hidden="true" className="size-5 text-emerald-500" strokeWidth={2} />
        ) : (
          <CircleAlert aria-hidden="true" className="size-5 text-destructive" strokeWidth={2} />
        )}
      </button>
      <span
        className="pointer-events-none absolute right-0 bottom-full z-20 mb-1.5 w-max max-w-72 rounded-xl bg-popover px-3 py-2 text-xs text-pretty text-popover-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
        id={tooltipId}
        role="tooltip"
      >
        {message}
      </span>
      <span aria-live="polite" className="sr-only">
        {message}
      </span>
    </span>
  );
}

function TokenAddressCard({
  addressReadOnly = false,
  chainName,
  iconUrl,
  id,
  identity,
  label,
  onChange,
  quote,
  showAddress = true,
  showMetadata = true,
  type,
  value,
  verification,
}: {
  addressReadOnly?: boolean;
  chainName: string;
  iconUrl?: string;
  id: string;
  identity?: ReactNode;
  label: string;
  onChange: (value: string) => void;
  quote?: boolean;
  showAddress?: boolean;
  showMetadata?: boolean;
  type: "Base" | "Quote";
  value: string;
  verification: TokenVerification;
}) {
  const token = verification.status === "valid" ? verification.token : null;

  return (
    <div className="flex flex-col gap-4 p-5">
      {identity ?? (
        <div className="flex items-center justify-start gap-3 py-1">
          <TokenReviewIcon compact key={iconUrl ?? token?.address ?? type} symbol={token?.symbol ?? ""} url={iconUrl} />
          <div className="min-w-0 text-left">
            <h3 className="truncate text-base font-semibold tracking-tight text-foreground">
              {token?.name ?? `${type} token`}
            </h3>
            <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground">
              {token?.symbol ?? "Not selected"}
            </p>
          </div>
        </div>
      )}

      {showMetadata ? (
        <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-border">
          <div className="border-r border-border px-4 py-3">
            <dt className="text-[10px] font-medium normal-case text-muted-foreground">Decimals</dt>
            <dd className="mt-1 font-mono text-base font-semibold tabular-nums">{token?.decimals ?? "—"}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-[10px] font-medium normal-case text-muted-foreground">Type</dt>
            <dd className="mt-1 text-base font-semibold">{type}</dd>
          </div>
        </dl>
      ) : null}

      {showAddress ? (
        <Field className="border-t border-border pt-4">
          <FieldLabel className="text-xs font-semibold" htmlFor={id}>
            {label}
          </FieldLabel>
          <div className="relative">
            <Input
              aria-invalid={verification.status === "error"}
              autoComplete="off"
              className="h-12 rounded-xl bg-muted/60 px-4 pr-12 font-mono text-sm"
              id={id}
              onChange={(event) => onChange(event.target.value)}
              placeholder="0x…"
              readOnly={addressReadOnly}
              spellCheck={false}
              value={value}
            />
            <TokenVerificationIndicator chainName={chainName} id={id} quote={quote} verification={verification} />
          </div>
        </Field>
      ) : null}
    </div>
  );
}

function buildMarketInput(pair: PairInfo): CreateMarketInput {
  return {
    baseAsset: pair.base.address,
    quoteAsset: pair.quote.address,
  };
}

function supportedPriceRange() {
  return {
    minimum: formatFraction(1n, priceScale, 18),
    maximum: formatFraction(maxUint128, priceScale, 18),
  };
}

function formatScientificPrice(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return value;
  if (Math.abs(number) >= 1_000_000 || Math.abs(number) < 0.001) {
    return number.toExponential(7).replace(/\.?0+e/, "e");
  }
  return value;
}

function formatNativeBalance(value: bigint, decimals: number) {
  const [integer, fraction = ""] = formatUnits(value, decimals).split(".");
  const groupedInteger = BigInt(integer).toLocaleString("en-US");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmedFraction ? `${groupedInteger}.${trimmedFraction}` : groupedInteger;
}

function MarketSetupCard({
  action,
  base,
  error,
  marketCreationFee,
  quoteIconUrl,
  quoteSymbol,
  tokenPriceRange,
  tokenPriceRangeTitle,
}: {
  action: ReactNode;
  base: ComponentProps<typeof TokenAddressCard>;
  error?: ReactNode;
  marketCreationFee: string;
  quoteIconUrl?: string;
  quoteSymbol: string;
  tokenPriceRange: string;
  tokenPriceRangeTitle: string;
}) {
  const reduceMotion = useReducedMotion() ?? false;

  return (
    <Card className="min-h-full w-full rounded-none bg-background py-0 ring-0">
      <CardHeader className="sr-only">
        <CardTitle>Market setup</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <TokenAddressCard {...base} />
        <dl className="border-t border-border">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <dt className="text-sm font-medium text-muted-foreground">Quote token</dt>
            <dd className="flex min-w-0 items-center gap-2.5">
              <TokenReviewIcon compact key={quoteIconUrl ?? quoteSymbol} symbol={quoteSymbol} url={quoteIconUrl} />
              <span className="truncate text-sm font-semibold">{quoteSymbol}</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-4">
            <dt className="text-sm font-medium text-muted-foreground">Trading fee</dt>
            <dd className="text-right font-mono text-sm font-semibold tabular-nums">0.10% maker + 0.10% taker</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-4">
            <dt className="text-sm font-medium text-muted-foreground">Market creation fee</dt>
            <dd className="text-right font-mono text-sm font-semibold tabular-nums">{marketCreationFee}</dd>
          </div>
          <div className="border-t border-border px-5 py-4">
            <dt className="text-sm font-medium text-muted-foreground">Token price range</dt>
            <dd
              className="mt-1.5 break-words font-mono text-sm font-semibold tabular-nums"
              title={tokenPriceRangeTitle}
            >
              {tokenPriceRange}
            </dd>
          </div>
        </dl>
        <div className="border-t border-border p-5">
          <AnimatePresence>
            {error ? (
              <motion.div
                animate={{ height: "auto", opacity: 1, y: 0 }}
                aria-live="polite"
                className="mb-3 overflow-hidden rounded-xl bg-destructive/10 text-xs text-destructive"
                exit={reduceMotion ? undefined : { height: 0, opacity: 0, y: -8 }}
                initial={reduceMotion ? false : { height: 0, opacity: 0, y: -8 }}
                role="alert"
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <div className="px-4 py-3">{error}</div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          {action}
        </div>
      </CardContent>
    </Card>
  );
}

export function CreateMarketScreen() {
  const router = useRouter();
  const { chainId, config, publicClient } = useClobChain();
  const quoteTokens = listedQuoteTokens(chainId);
  const creator = useCreateMarket();
  const [baseAddress, setBaseAddress] = useState("");
  const [marketCreationFee, setMarketCreationFee] = useState<bigint | null>(null);
  const [embeddedWalletBalance, setEmbeddedWalletBalance] = useState<bigint | null>(null);
  const quoteAddress = quoteTokens[0]?.address ?? "";
  const [inspectedPair, setInspectedPair] = useState<PairInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const baseVerification = useTokenVerification(baseAddress, creator.inspectToken);
  const quoteVerification = useTokenVerification(quoteAddress, creator.inspectToken, creator.isQuoteTokenApproved);
  const baseVerifiedForInput =
    baseVerification.status === "valid" &&
    baseVerification.token.address.toLowerCase() === baseAddress.trim().toLowerCase();
  const quoteVerifiedForInput =
    quoteVerification.status === "valid" &&
    quoteVerification.token.address.toLowerCase() === quoteAddress.trim().toLowerCase();
  const pairVerified = baseVerifiedForInput && quoteVerifiedForInput;
  const pair = inspectedPair;
  const preview = useMemo(() => (pair ? buildMarketInput(pair) : null), [pair]);
  const priceRange = useMemo(() => (pair ? supportedPriceRange() : null), [pair]);
  const minimumOrderValue = pair
    ? `${formatFraction(1n, 10n ** BigInt(pair.quote.decimals), 24)} ${pair.quote.symbol}`
    : "—";
  const tokenPriceRangeTitle =
    priceRange && pair ? `${priceRange.minimum}–${priceRange.maximum} ${pair.quote.symbol}` : "—";
  const tokenPriceRange =
    priceRange && pair
      ? `${formatScientificPrice(priceRange.minimum)}–${formatScientificPrice(priceRange.maximum)} ${pair.quote.symbol}`
      : "—";
  const tokenIconUrl = (token: MarketToken) => listedTokenIconUrl(chainId, token.address);
  const selectedQuote = quoteTokens.find((token) => token.address.toLowerCase() === quoteAddress.toLowerCase());
  const marketCreationFeeDisplay =
    marketCreationFee === null
      ? "—"
      : `${formatUnits(marketCreationFee, config.chain.nativeCurrency.decimals)} ${config.chain.nativeCurrency.symbol}`;
  const embeddedWalletBalanceDisplay =
    embeddedWalletBalance === null
      ? "—"
      : formatNativeBalance(embeddedWalletBalance, config.chain.nativeCurrency.decimals);
  const marketCreationFeeWithBalance = `${marketCreationFeeDisplay} | Bal ${embeddedWalletBalanceDisplay} ${config.chain.nativeCurrency.symbol}`;
  const quoteSymbol =
    quoteVerification.status === "valid" ? quoteVerification.token.symbol : (selectedQuote?.symbol ?? "Quote");
  const quoteIconUrl =
    quoteVerification.status === "valid" ? tokenIconUrl(quoteVerification.token) : selectedQuote?.iconUrl;
  const existingMarket = inspectedPair?.existingPoolId ? inspectedPair : null;
  const setupError =
    formError ??
    creator.transaction.error?.message ??
    (existingMarket ? (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span>{`${existingMarket.base.symbol}/${existingMarket.quote.symbol} already has a market.`}</span>
        <Link
          className="shrink-0 border-b-2 border-current pb-0.5 font-medium text-foreground hover:text-foreground/80"
          href={`/${chainId}/markets/${existingMarket.existingPoolId}/trade`}
        >
          Go to market
        </Link>
      </div>
    ) : null);

  useEffect(() => {
    if (!config.factoryAddress) {
      setMarketCreationFee(null);
      return;
    }

    let active = true;
    setMarketCreationFee(null);
    void publicClient
      .readContract({ address: config.factoryAddress, abi: poolRegistryAbi, functionName: "marketCreationFee" })
      .then((fee) => {
        if (active) setMarketCreationFee(fee);
      })
      .catch(() => {
        if (active) setMarketCreationFee(null);
      });

    return () => {
      active = false;
    };
  }, [config.factoryAddress, publicClient]);

  useEffect(() => {
    const walletAddress = creator.wallet?.address;
    if (!walletAddress || !isAddress(walletAddress)) {
      setEmbeddedWalletBalance(null);
      return;
    }

    let active = true;
    setEmbeddedWalletBalance(null);
    void publicClient
      .getBalance({ address: getAddress(walletAddress) })
      .then((balance) => {
        if (active) setEmbeddedWalletBalance(balance);
      })
      .catch(() => {
        if (active) setEmbeddedWalletBalance(null);
      });

    return () => {
      active = false;
    };
  }, [creator.wallet?.address, publicClient]);

  useEffect(() => {
    if (!pairVerified) {
      setInspecting(false);
      return;
    }

    let active = true;
    setInspecting(true);
    setFormError(null);
    void creator
      .inspectPair(baseAddress.trim(), quoteAddress.trim())
      .then((inspected) => {
        if (active) setInspectedPair(inspected);
      })
      .catch((error) => {
        if (active) {
          setInspectedPair(null);
          setFormError(error instanceof Error ? error.message : "Could not inspect the token pair");
        }
      })
      .finally(() => {
        if (active) setInspecting(false);
      });

    return () => {
      active = false;
    };
  }, [baseAddress, creator.inspectPair, pairVerified, quoteAddress]);

  const createMarket = async () => {
    if (!pair) return;
    setFormError(null);
    try {
      const input = buildMarketInput(pair);
      const market = await creator.createMarket(input);
      router.push(`/${chainId}/markets/${market.poolId}/trade`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Market creation failed");
    }
  };

  return (
    <div className="bg-background text-foreground">
      <main className="w-full">
        <div>
          <div className="grid items-stretch border-b-[0.5px] border-border xl:min-h-[calc(100svh-4rem)] xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
            <section className="flex min-w-0 border-b-[0.5px] border-border xl:border-r-[0.5px] xl:border-b-0">
              <PriceBitmapChart
                hasVerifiedBaseToken={baseVerifiedForInput}
                loading={inspecting}
                maximumPrice={priceRange?.maximum}
                minimumTrade={pair ? `Dynamic · enough to settle 1 ${pair.quote.symbol} atom` : "—"}
                minimumOrderValue={minimumOrderValue}
                minimumPrice={priceRange?.minimum}
                quoteSymbol={quoteVerification.status === "valid" ? quoteVerification.token.symbol : "Quote"}
                tickSize={`1e-18 ${quoteVerification.status === "valid" ? quoteVerification.token.symbol : "quote-token"} per token`}
              />
            </section>

            <aside className="min-w-0">
              <MarketSetupCard
                base={{
                  chainName: config.chain.name,
                  iconUrl: baseVerification.status === "valid" ? tokenIconUrl(baseVerification.token) : undefined,
                  id: "base-token",
                  label: "Base token address",
                  onChange: (value) => {
                    setBaseAddress(value);
                    setInspectedPair(null);
                    setFormError(null);
                  },
                  type: "Base",
                  value: baseAddress,
                  verification: baseVerification,
                }}
                error={setupError}
                marketCreationFee={marketCreationFeeWithBalance}
                quoteIconUrl={quoteIconUrl}
                quoteSymbol={quoteSymbol}
                tokenPriceRange={tokenPriceRange}
                tokenPriceRangeTitle={tokenPriceRangeTitle}
                action={
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          className="h-11 w-full rounded-full"
                          disabled={inspecting || !pair || Boolean(pair.existingPoolId)}
                          size="lg"
                        />
                      }
                    >
                      {inspecting ? (
                        <LoaderCircle
                          aria-hidden="true"
                          className="animate-spin motion-reduce:animate-none"
                          data-icon="inline-start"
                        />
                      ) : null}
                      {inspecting ? "Checking pair…" : "Continue"}
                    </AlertDialogTrigger>

                    {pair && !pair.existingPoolId ? (
                      <AlertDialogContent className="gap-5">
                        <AlertDialogTitle className="sr-only">Confirm market</AlertDialogTitle>

                        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-muted p-4">
                          <div className="flex min-w-0 items-center gap-3">
                            <TokenReviewIcon
                              compact
                              key={tokenIconUrl(pair.base) ?? pair.base.address}
                              symbol={pair.base.symbol}
                              url={tokenIconUrl(pair.base)}
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{pair.base.name}</p>
                              <p className="truncate text-xs text-muted-foreground">{pair.base.symbol} · Base</p>
                            </div>
                          </div>
                          <ArrowLeftRight
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                            strokeWidth={1.5}
                          />
                          <div className="flex min-w-0 items-center justify-end gap-3 text-right">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{pair.quote.name}</p>
                              <p className="truncate text-xs text-muted-foreground">{pair.quote.symbol} · Quote</p>
                            </div>
                            <TokenReviewIcon
                              compact
                              key={tokenIconUrl(pair.quote) ?? pair.quote.address}
                              symbol={pair.quote.symbol}
                              url={tokenIconUrl(pair.quote)}
                            />
                          </div>
                        </div>

                        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border">
                          <ConfigItem label="Quantity precision" mono value={`${pair.base.decimals} decimals`} />
                          <ConfigItem label="Minimum order value" mono value={minimumOrderValue} />
                          <ConfigItem label="Price keys" mono value="Full uint128 range" />
                          <ConfigItem label="Price precision" mono value={`1e-18 ${pair.quote.symbol}/token`} />
                          <ConfigItem label="Token price range" mono value={tokenPriceRange} />
                          <ConfigItem label="Trading fee" mono value="0.10% maker + 0.10% taker" />
                        </dl>

                        {formError || creator.transaction.error ? (
                          <div
                            aria-live="polite"
                            className="rounded-xl bg-destructive/10 px-4 py-3 text-xs text-destructive"
                            role="alert"
                          >
                            {formError ?? creator.transaction.error?.message}
                          </div>
                        ) : null}

                        <AlertDialogFooter>
                          <AlertDialogCancel
                            className="h-10 rounded-full"
                            onClick={() => {
                              setFormError(null);
                              creator.resetTransaction();
                            }}
                            size="lg"
                          >
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            className="h-10 rounded-full sm:min-w-36"
                            disabled={!preview || creator.transaction.loading || !creator.ready}
                            onClick={() => {
                              if (!creator.authenticated || !creator.wallet) creator.connect();
                              else void createMarket();
                            }}
                            size="lg"
                          >
                            {creator.transaction.loading ? (
                              <LoaderCircle
                                aria-hidden="true"
                                className="animate-spin motion-reduce:animate-none"
                                data-icon="inline-start"
                              />
                            ) : null}
                            {creator.transaction.loading
                              ? "Creating…"
                              : creator.authenticated && creator.wallet
                                ? "Create market"
                                : "Connect wallet"}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    ) : null}
                  </AlertDialog>
                }
              />
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
