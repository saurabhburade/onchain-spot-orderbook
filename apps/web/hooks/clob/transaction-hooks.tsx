"use client";

import { useAuthorizationSignature, usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, encodeFunctionData, type Hash, type Hex, parseUnits } from "viem";

import { clobAbi, erc20Abi } from "@/config/abis";
import { ANVIL_CHAIN_ID, MONAD_TESTNET_CHAIN_ID } from "@/config/constants";
import { createPrivyWalletClient, waitForTransaction } from "@/config/viem";
import { type AtomicCall, encodeAtomicBatch } from "@/lib/clob/atomic-batch";
import { useClobChain } from "@/lib/clob/chain-context";
import type { DirectUserOperationResult } from "@/lib/clob/direct-userop-client";
import { submitDirectUserOperationWithSessionKey } from "@/lib/clob/kernel-session-client";
import { sendPrivySponsoredCalls, waitForPrivyTransaction } from "@/lib/clob/privy-wallet-api";
import { headlessTransactionOptions } from "@/lib/clob/transaction-options";
import type {
  AnvilFaucetInput,
  LimitOrderInput,
  MarketOrderInput,
  PoolId,
  PoolMetadata,
  TransactionState,
} from "@/lib/clob/types";
import { parsePriceToRaw, parseQuantityToLots, quoteAmountRaw, quoteAmountWithPoolFee } from "@/lib/clob/utils";
import { useClobWallet } from "@/lib/clob/wallet";
import { useBalances, useUserOrders } from "./account-hooks";
import { useOrderbook } from "./market-data-hooks";
import { usePoolMetadata } from "./market-hooks";
import { clobError, transactionError } from "./shared";

export function useClobActions(poolId?: PoolId, pool?: PoolMetadata | null, onConfirmed?: () => Promise<void>) {
  const { chainId, config, publicClient } = useClobChain();
  const { authenticated, ready, tradingAddress, wallet, walletId } = useClobWallet();
  const { getAccessToken } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const { generateAuthorizationSignature } = useAuthorizationSignature();
  const [transaction, setTransaction] = useState<TransactionState>({ status: "idle", loading: false, error: null });
  const pendingTransactionRef = useRef<Promise<Hash | undefined> | null>(null);
  const trackingControllersRef = useRef(new Set<AbortController>());
  const transactionSequenceRef = useRef(0);

  useEffect(
    () => () => {
      transactionSequenceRef.current += 1;
      for (const controller of trackingControllersRef.current) controller.abort();
      trackingControllersRef.current.clear();
    },
    [],
  );

  type ImmediateTransaction = DirectUserOperationResult;
  type SubmittedTransaction = { transactionId?: string; hash?: Hash; completion: Promise<Hash> };

  const run = useCallback(
    (operation: () => Promise<Hash | ImmediateTransaction | SubmittedTransaction>) => {
      if (pendingTransactionRef.current) return pendingTransactionRef.current;
      if (!authenticated || !ready || !wallet) {
        const error = new Error("Connect an Ethereum wallet before submitting a transaction");
        setTransaction({ status: "error", loading: false, error });
        return Promise.reject(error);
      }

      const pending = (async () => {
        const sequence = ++transactionSequenceRef.current;
        setTransaction({ status: "pending", loading: true, error: null });
        try {
          const result = await operation();
          if (typeof result === "string") {
            if (onConfirmed) await onConfirmed();
            if (transactionSequenceRef.current === sequence) {
              setTransaction({ status: "success", loading: false, error: null, hash: result });
            }
            return result;
          }

          if ("metrics" in result) {
            if (onConfirmed) void onConfirmed().catch(() => undefined);
            if (transactionSequenceRef.current === sequence) {
              setTransaction({
                status: "success",
                loading: false,
                error: null,
                hash: result.hash,
                metrics: result.metrics,
              });
            }
            return result.hash;
          }

          setTransaction({
            status: "submitted",
            loading: false,
            error: null,
            hash: result.hash,
            transactionId: result.transactionId,
          });
          void result.completion
            .then(async (hash) => {
              if (onConfirmed) await onConfirmed();
              if (transactionSequenceRef.current === sequence) {
                setTransaction({
                  status: "success",
                  loading: false,
                  error: null,
                  hash,
                  transactionId: result.transactionId,
                });
              }
            })
            .catch((error) => {
              if (transactionSequenceRef.current === sequence) {
                setTransaction({
                  status: "error",
                  loading: false,
                  error: transactionError(error),
                  transactionId: result.transactionId,
                });
              }
            });
          return undefined;
        } catch (error) {
          const normalized = transactionError(error);
          if (transactionSequenceRef.current === sequence) {
            setTransaction({ status: "error", loading: false, error: normalized });
          }
          throw normalized;
        } finally {
          pendingTransactionRef.current = null;
        }
      })();
      pendingTransactionRef.current = pending;
      return pending;
    },
    [authenticated, onConfirmed, ready, wallet],
  );

  const sendPrivyOrder = useCallback(
    async (calls: readonly AtomicCall[]): Promise<SubmittedTransaction> => {
      if (!wallet || !walletId || !tradingAddress) throw new Error("The Privy embedded wallet is not ready");
      if (chainId !== MONAD_TESTNET_CHAIN_ID) throw new Error("Privy sponsorship is only enabled on Monad testnet");
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Your Privy session expired before the order could be submitted");
      const transactionId = await sendPrivySponsoredCalls({
        accessToken,
        calls,
        chainId,
        generateAuthorizationSignature,
        walletId,
      });
      const controller = new AbortController();
      trackingControllersRef.current.add(controller);
      const completion = waitForPrivyTransaction({
        walletId,
        transactionId,
        getAccessToken,
        signal: controller.signal,
      }).finally(() => {
        trackingControllersRef.current.delete(controller);
      });
      return {
        transactionId,
        completion,
      };
    },
    [chainId, generateAuthorizationSignature, getAccessToken, tradingAddress, wallet, walletId],
  );

  const sendDirectOrder = useCallback(
    async (calls: readonly AtomicCall[]): Promise<Hash | ImmediateTransaction | SubmittedTransaction> => {
      const activeWallet = wallet;
      const activeTrader = tradingAddress;
      if (!activeWallet || !activeTrader) throw new Error("The Privy embedded wallet is not ready");
      if (chainId !== MONAD_TESTNET_CHAIN_ID)
        throw new Error("Direct UserOperations are only supported on Monad testnet");
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Your Privy session expired before the order could be submitted");

      return submitDirectUserOperationWithSessionKey({
        accessToken,
        chainId,
        calls,
        sender: activeTrader,
        onAccountNotDelegated: () => sendPrivyOrder(calls),
      });
    },
    [chainId, getAccessToken, sendPrivyOrder, tradingAddress, wallet],
  );

  const sendAtomicOrder = useCallback(
    async (asset: Address, spender: Address, amount: bigint, orderData: Hex) => {
      const activeWallet = wallet;
      const activeTrader = tradingAddress;
      if (!activeWallet || !activeTrader) throw new Error("Connect an Ethereum wallet before placing an order");
      const allowance = await publicClient.readContract({
        address: asset,
        abi: erc20Abi,
        functionName: "allowance",
        args: [activeTrader, spender],
      });
      const calls: AtomicCall[] = [];
      if (allowance < amount) {
        const maxUint256 = (1n << 256n) - 1n;
        const approvalAmount = amount > maxUint256 / 10n ? maxUint256 : amount * 10n;
        calls.push({
          to: asset,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, approvalAmount] }),
        });
      }
      calls.push({ to: spender, data: orderData });

      if (chainId === MONAD_TESTNET_CHAIN_ID) return sendDirectOrder(calls);

      const data = encodeAtomicBatch(calls);
      const { hash } = await sendTransaction(
        { chainId, data, to: activeWallet.address as Address },
        headlessTransactionOptions(activeWallet.address, chainId),
      );
      await waitForTransaction(chainId, hash);
      return hash;
    },
    [chainId, publicClient, sendDirectOrder, sendTransaction, tradingAddress, wallet],
  );

  const placeLimit = useCallback(
    (input: LimitOrderInput) =>
      run(async () => {
        const contractAddress = pool?.clobAddress;
        const activeTrader = tradingAddress;
        if (!pool || !contractAddress || !poolId || !activeTrader)
          throw clobError(contractAddress) ?? new Error("Pool metadata is unavailable");
        const price = parsePriceToRaw(input.price, pool);
        const quantity = parseQuantityToLots(input.quantity, pool);
        const orderAsset = input.side === "buy" ? pool.quoteAsset : pool.baseAsset;
        const quoteAmount = quoteAmountRaw(price, quantity, pool);
        const escrowAmount =
          input.side === "buy"
            ? quoteAmountWithPoolFee(quoteAmount, pool)
            : pool.agnosticPricing
              ? quantity
              : pool.lotSize * quantity;
        const data = encodeFunctionData({
          abi: clobAbi,
          functionName: "placeLimitOrderWithMaxBookSteps",
          args: [
            {
              trader: activeTrader,
              baseAsset: pool.baseAsset,
              quoteAsset: pool.quoteAsset,
              side: input.side === "buy" ? 0 : 1,
              price,
              quantity,
              expiry: input.expiry ?? 0n,
              clientOrderId: input.clientOrderId ?? 0n,
            },
            (input.maxBookSteps ?? 64n) as unknown as number,
          ],
        });
        return sendAtomicOrder(orderAsset, contractAddress, escrowAmount, data);
      }),
    [pool, poolId, run, sendAtomicOrder, tradingAddress],
  );

  const executeMarket = useCallback(
    (input: MarketOrderInput) =>
      run(async () => {
        const contractAddress = pool?.clobAddress;
        const activeTrader = tradingAddress;
        if (!pool || !contractAddress || !poolId || !activeTrader)
          throw clobError(contractAddress) ?? new Error("Pool metadata is unavailable");
        const quantity = parseQuantityToLots(input.quantity, pool);
        const priceLimit = input.priceLimit ? parsePriceToRaw(input.priceLimit, pool) : 0n;
        const effectiveLimit = priceLimit || (pool.agnosticPricing ? (1n << 128n) - 1n : pool.maxTick * pool.tickSize);
        const orderAsset = input.side === "buy" ? pool.quoteAsset : pool.baseAsset;
        const maxQuote = quoteAmountRaw(effectiveLimit, quantity, pool);
        const escrowAmount =
          input.side === "buy"
            ? quoteAmountWithPoolFee(maxQuote, pool)
            : pool.agnosticPricing
              ? quantity
              : pool.lotSize * quantity;
        const data = encodeFunctionData({
          abi: clobAbi,
          functionName: "executeMarketOrder",
          args: [
            {
              trader: activeTrader,
              baseAsset: pool.baseAsset,
              quoteAsset: pool.quoteAsset,
              side: input.side === "buy" ? 0 : 1,
              quantity,
              priceLimit,
              minFillQuantity: input.minFillQuantity ? parseQuantityToLots(input.minFillQuantity, pool) : 0n,
              clientOrderId: input.clientOrderId ?? 0n,
            },
            (input.maxBookSteps ?? 64n) as unknown as number,
          ],
        });
        return sendAtomicOrder(orderAsset, contractAddress, escrowAmount, data);
      }),
    [pool, poolId, run, sendAtomicOrder, tradingAddress],
  );

  const cancel = useCallback(
    (orderId: PoolId) =>
      run(async () => {
        const contractAddress = pool?.clobAddress;
        const activeWallet = wallet;
        if (!contractAddress || !activeWallet || !tradingAddress)
          throw clobError(contractAddress) ?? new Error("Connect an Ethereum wallet before cancelling an order");
        const data = encodeFunctionData({ abi: clobAbi, functionName: "cancelOrder", args: [orderId] });
        if (chainId === MONAD_TESTNET_CHAIN_ID) return sendDirectOrder([{ to: contractAddress, data }]);
        const { hash } = await sendTransaction(
          { chainId, data, to: contractAddress },
          headlessTransactionOptions(activeWallet.address, chainId),
        );
        await waitForTransaction(chainId, hash);
        return hash;
      }),
    [chainId, pool?.clobAddress, run, sendDirectOrder, sendTransaction, tradingAddress, wallet],
  );

  const anvilFaucet = useCallback(
    async (input: AnvilFaucetInput = {}) => {
      if (
        chainId !== ANVIL_CHAIN_ID ||
        (config.rpcUrl !== "http://127.0.0.1:8545" && config.rpcUrl !== "http://localhost:8545")
      ) {
        const error = new Error("The developer faucet is restricted to the default local Anvil RPC");
        setTransaction({ status: "error", loading: false, error });
        throw error;
      }
      if (!pool || !wallet || !authenticated || !ready) {
        const error = new Error("Connect an Ethereum wallet before using the Anvil faucet");
        setTransaction({ status: "error", loading: false, error });
        throw error;
      }
      setTransaction({ status: "pending", loading: true, error: null });
      try {
        // Tied to the custom chain id and local RPC: this cannot run on Monad.
        if (chainId !== ANVIL_CHAIN_ID) throw new Error("Developer faucet is only available on Anvil");
        const nativeAmount = parseUnits(input.nativeAmount ?? "100", 18);
        const requestDevRpc = publicClient.request as unknown as (request: {
          method: string;
          params: readonly unknown[];
        }) => Promise<unknown>;
        await requestDevRpc({
          method: "anvil_setBalance",
          params: [wallet.address as Address, `0x${nativeAmount.toString(16)}`],
        });
        const client = await createPrivyWalletClient(wallet, config);
        let hash: Hash | undefined;
        const mint = async (asset: Address, amount: string | undefined, decimals: number) => {
          if (!amount) return;
          const rawAmount = parseUnits(amount, decimals);
          if (rawAmount <= 0n) throw new Error("Faucet token amounts must be positive");
          hash = await client.writeContract({
            address: asset,
            abi: erc20Abi,
            functionName: "mint",
            args: [wallet.address as Address, rawAmount],
          });
          await waitForTransaction(chainId, hash);
        };
        await mint(pool.baseAsset, input.baseAmount, pool.baseDecimals);
        await mint(pool.quoteAsset, input.quoteAmount, pool.quoteDecimals);
        if (onConfirmed) await onConfirmed();
        setTransaction({ status: "success", loading: false, error: null, hash });
        return hash;
      } catch (error) {
        const normalized = transactionError(error);
        setTransaction({ status: "error", loading: false, error: normalized });
        throw normalized;
      }
    },
    [authenticated, chainId, config, onConfirmed, pool, publicClient, ready, wallet],
  );

  const resetTransaction = useCallback(() => setTransaction({ status: "idle", loading: false, error: null }), []);
  return { transaction, placeLimit, executeMarket, cancel, anvilFaucet, resetTransaction, authenticated, ready };
}

export function useClob(poolId?: PoolId, depth = 20) {
  // Standalone hooks intentionally retain independent read/error lifecycles;
  // the aggregate hook therefore performs a few duplicate metadata reads.
  const pool = usePoolMetadata(poolId);
  const orderbook = useOrderbook(poolId, depth);
  const bestPrices = {
    data: orderbook.data ? { bid: orderbook.data.bids[0] ?? null, ask: orderbook.data.asks[0] ?? null } : null,
    error: orderbook.error,
    loading: orderbook.loading,
    refetch: orderbook.refetch,
  };
  const balances = useBalances(poolId);
  const userOrders = useUserOrders(poolId);
  const openOrders = { ...userOrders, data: userOrders.openData };
  const orderHistory = { ...userOrders, data: userOrders.data };
  const refetch = useCallback(async () => {
    await Promise.all([pool.refetch(), orderbook.refetch(), balances.refetch(), userOrders.refetch()]);
  }, [balances.refetch, orderbook.refetch, pool.refetch, userOrders.refetch]);
  const actions = useClobActions(poolId, pool.data, refetch);
  return { pool, orderbook, bestPrices, balances, openOrders, orderHistory, ...actions, refetch };
}
