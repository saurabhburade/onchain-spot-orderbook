"use client";

import { usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { Check, Coins, Copy, LoaderCircle } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { type Address, encodeFunctionData, type Hash, parseEventLogs, parseUnits } from "viem";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { tokenFactoryAbi } from "@/config/abis";
import { waitForTransaction } from "@/config/viem";
import { MONAD_TESTNET_CHAIN_ID, useClobChain, useClobWallet } from "@/lib/clob";
import type { DirectUserOperationResult } from "@/lib/clob/direct-userop-client";
import { submitDirectUserOperationWithSessionKey } from "@/lib/clob/kernel-session-client";
import { headlessTransactionOptions } from "@/lib/clob/transaction-options";
import { sanitizeDecimalInput, sanitizeIntegerInput } from "@/lib/utils";

const showTransactionLatency = process.env.NODE_ENV !== "production";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Token deployment failed";
}

export function DeployTokenScreen() {
  const { chainId, config } = useClobChain();
  const { authenticated, connect, ready, wallet } = useClobWallet();
  const { getAccessToken } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [initialSupply, setInitialSupply] = useState("1000000");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<{
    address: Address;
    hash: Hash;
    metrics?: DirectUserOperationResult["metrics"];
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const deploy = async () => {
    if (!config.tokenFactoryAddress) {
      setError(`Token factory is not configured for ${config.chain.name}`);
      return;
    }
    if (!wallet || !authenticated || !ready) {
      connect();
      return;
    }

    const parsedDecimals = Number(decimals);
    if (!name.trim() || !symbol.trim()) {
      setError("Enter a token name and symbol");
      return;
    }
    if (!Number.isInteger(parsedDecimals) || parsedDecimals < 0 || parsedDecimals > 255) {
      setError("Decimals must be a whole number from 0 to 255");
      return;
    }

    setLoading(true);
    setError(null);
    setDeployed(null);
    try {
      const rawSupply = parseUnits(initialSupply.trim(), parsedDecimals);
      if (rawSupply < 0n) throw new Error("Initial supply cannot be negative");
      const data = encodeFunctionData({
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: [name.trim(), symbol.trim(), parsedDecimals, rawSupply],
      });
      const transactionRequest = { chainId, data, to: config.tokenFactoryAddress } as const;
      let hash: Hash;
      let metrics: DirectUserOperationResult["metrics"] | undefined;
      if (chainId === MONAD_TESTNET_CHAIN_ID) {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("Your Privy session expired before the token could be deployed");
        const result = await submitDirectUserOperationWithSessionKey<Hash>({
          accessToken,
          chainId,
          calls: [{ to: config.tokenFactoryAddress, data }],
          sender: wallet.address as Address,
          onAccountNotDelegated: async () =>
            (await sendTransaction(transactionRequest, headlessTransactionOptions(wallet.address, chainId))).hash,
        });
        if (typeof result === "string") hash = result;
        else {
          hash = result.hash;
          metrics = result.metrics;
        }
      } else {
        ({ hash } = await sendTransaction(transactionRequest, headlessTransactionOptions(wallet.address, chainId)));
      }
      const receipt = await waitForTransaction(chainId, hash);
      const events = parseEventLogs({
        abi: tokenFactoryAbi,
        eventName: "TokenCreated",
        logs: receipt.logs,
      });
      const token = events[0]?.args.token;
      if (!token) throw new Error("Token deployed, but its address was not found in the receipt");
      setDeployed({ address: token, hash, metrics });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background text-foreground">
      <main className="flex min-h-[calc(100dvh-6.75rem)] w-full flex-col lg:min-h-[calc(100dvh-4rem)]">
        <div className="grid flex-1 items-stretch border-b-[0.5px] border-border xl:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)]">
          <section className="relative isolate overflow-hidden border-b-[0.5px] border-border px-4 py-8 sm:px-6 lg:px-5 xl:border-r-[0.5px] xl:border-b-0 xl:px-8 xl:py-10">
            <Image
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-20 size-full object-cover object-center opacity-[0.22] mix-blend-multiply dark:invert dark:hue-rotate-180 dark:mix-blend-screen"
              fill
              priority
              sizes="(min-width: 1280px) 70vw, 100vw"
              src="/dither-space.png"
            />
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-background/45" />
            <div className="relative flex size-10 items-center justify-center rounded-xl bg-muted/90 backdrop-blur-sm">
              <Coins aria-hidden="true" className="size-5" strokeWidth={1.5} />
            </div>
            <h1 className="relative mt-4 text-balance text-3xl font-semibold tracking-tight">Deploy an ERC-20</h1>
            <p className="relative mt-2 max-w-2xl text-pretty text-sm text-muted-foreground">
              Create a mintable token on {config.chain.name}. Your connected wallet receives the initial supply and
              controls future minting.
            </p>
          </section>

          <section className="min-w-0">
            <Card className="min-h-full w-full rounded-none bg-background py-0 ring-0">
              <CardHeader className="border-b border-border px-4 py-5 sm:px-6 lg:px-5 xl:px-8">
                <CardTitle>Token details</CardTitle>
                <CardDescription>Token metadata cannot be changed after deployment.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-5 xl:px-8 xl:py-8">
                <div className="grid gap-4">
                  <Field>
                    <FieldLabel htmlFor="token-name">Name</FieldLabel>
                    <Input
                      className="h-11 rounded-xl"
                      id="token-name"
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Example USD"
                      value={name}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="token-symbol">Symbol</FieldLabel>
                    <Input
                      className="h-11 rounded-xl uppercase"
                      id="token-symbol"
                      onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                      placeholder="XUSD"
                      value={symbol}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="token-decimals">Decimals</FieldLabel>
                    <Input
                      autoComplete="off"
                      autoCorrect="off"
                      className="h-11 rounded-xl font-mono tabular-nums"
                      id="token-decimals"
                      inputMode="numeric"
                      max="255"
                      min="0"
                      onChange={(event) => setDecimals(sanitizeIntegerInput(event.target.value))}
                      spellCheck={false}
                      value={decimals}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="token-supply">Initial supply</FieldLabel>
                    <Input
                      autoComplete="off"
                      autoCorrect="off"
                      className="h-11 rounded-xl font-mono tabular-nums"
                      id="token-supply"
                      inputMode="decimal"
                      min="0"
                      onChange={(event) => setInitialSupply(sanitizeDecimalInput(event.target.value))}
                      spellCheck={false}
                      value={initialSupply}
                    />
                  </Field>
                </div>

                <div className="border-t border-border pt-5">
                  <Button
                    className="h-9 w-full rounded-full active:scale-[0.96]"
                    disabled={loading || !config.tokenFactoryAddress}
                    onClick={() => void deploy()}
                    size="default"
                  >
                    {loading ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin motion-reduce:animate-none"
                        data-icon="inline-start"
                      />
                    ) : null}
                    {loading ? "Deploying…" : authenticated && wallet ? "Deploy token" : "Connect wallet to deploy"}
                  </Button>
                </div>

                {!config.tokenFactoryAddress ? (
                  <p
                    className="rounded-xl bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400"
                    role="status"
                  >
                    The token factory is not configured for this network yet.
                  </p>
                ) : null}
                {error ? (
                  <p className="rounded-xl bg-destructive/10 px-4 py-3 text-xs text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
                {deployed ? (
                  <div className="rounded-xl bg-chart-3/10 p-4" role="status">
                    <div className="flex items-center gap-2 text-sm font-medium text-chart-3">
                      <Check aria-hidden="true" className="size-4" strokeWidth={2} /> Token deployed
                    </div>
                    {showTransactionLatency && deployed.metrics ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Submitted in {deployed.metrics.totalMs} ms (
                        {deployed.metrics.setupMs ? `one-time setup ${deployed.metrics.setupMs} ms, ` : ""}
                        {deployed.metrics.prepareMs !== undefined
                          ? deployed.metrics.prepareBreakdown
                            ? `prepare API ${deployed.metrics.prepareMs} ms [browser↔API/Next ${deployed.metrics.prepareBreakdown.networkMs} ms, auth ${deployed.metrics.prepareBreakdown.authMs} ms, RPC wall ${deployed.metrics.prepareBreakdown.rpcWallMs} ms (nonce ${deployed.metrics.prepareBreakdown.nonceMs}, delegation ${deployed.metrics.prepareBreakdown.delegationMs}, order book ${deployed.metrics.prepareBreakdown.orderBookMs}, chain ${deployed.metrics.prepareBreakdown.chainIdMs}), local validate/hash ${deployed.metrics.prepareBreakdown.localMs} ms, response ${deployed.metrics.prepareBreakdown.responseMs} ms], `
                            : `local prepare ${deployed.metrics.prepareMs} ms, `
                          : ""}
                        local sign {deployed.metrics.signMs} ms,{" "}
                        {deployed.metrics.submitBreakdown
                          ? `submit API ${deployed.metrics.submitMs} ms [browser↔API/Next ${deployed.metrics.submitBreakdown.networkMs} ms, auth ${deployed.metrics.submitBreakdown.authMs} ms, RPC batch wall ${deployed.metrics.submitBreakdown.validationWallMs} ms (chain ${deployed.metrics.submitBreakdown.chainIdMs}, delegation ${deployed.metrics.submitBreakdown.delegationMs}, order book ${deployed.metrics.submitBreakdown.orderBookMs}, policy ${deployed.metrics.submitBreakdown.policyRpcMs}, UserOp nonce ${deployed.metrics.submitBreakdown.nonceMs}, hash ${deployed.metrics.submitBreakdown.hashMs}, simulation ${deployed.metrics.submitBreakdown.simulationMs}, sponsor fields ${deployed.metrics.submitBreakdown.broadcastPrepareMs} [nonce ${deployed.metrics.submitBreakdown.sponsorNonceMs}, gas price ${deployed.metrics.submitBreakdown.gasPriceMs}]), broadcast ${deployed.metrics.submitBreakdown.broadcastMs} ms (sponsor sign ${deployed.metrics.submitBreakdown.sponsorSignMs}, eth_sendRawTransaction ${deployed.metrics.submitBreakdown.rpcSubmissionMs}), response ${deployed.metrics.submitBreakdown.responseMs} ms]`
                          : `submit API ${deployed.metrics.submitMs} ms`}
                        )
                      </p>
                    ) : null}
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2">
                      <code className="min-w-0 flex-1 truncate text-xs tabular-nums">{deployed.address}</code>
                      <Button
                        aria-label="Copy token address"
                        onClick={() => {
                          void navigator.clipboard.writeText(deployed.address).then(() => {
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1500);
                          });
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </section>
        </div>
      </main>
    </div>
  );
}
