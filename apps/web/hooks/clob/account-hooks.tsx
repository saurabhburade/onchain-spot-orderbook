"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";

import { clobAbi, clobLensAbi, erc20Abi } from "@/config/abis";
import { createRequestCoalescer } from "@/lib/clob/async-cache";
import { subscribeToBalanceRefresh } from "@/lib/clob/balance-refresh";
import { useClobChain } from "@/lib/clob/chain-context";
import type { AsyncState, OpenOrder, PoolId, PoolMetadata, TokenBalance } from "@/lib/clob/types";
import { formatPrice, formatQuantity, formatQuote, toError } from "@/lib/clob/utils";
import { useClobWallet } from "@/lib/clob/wallet";
import { usePoolMetadata } from "./market-hooks";
import { clobError, EMPTY_ASYNC } from "./shared";

export function useBalances(poolId?: PoolId) {
  const { publicClient } = useClobChain();
  const pool = usePoolMetadata(poolId);
  const { authenticated, tradingAddress } = useClobWallet();
  const [data, setData] = useState<{ base: TokenBalance; quote: TokenBalance } | null>(null);
  const [state, setState] = useState<AsyncState>(EMPTY_ASYNC);
  const refetch = useCallback(async () => {
    if (!pool.data || !tradingAddress || !authenticated) {
      setData(null);
      return;
    }
    const contractAddress = pool.data.clobAddress;
    const error = clobError(contractAddress);
    if (error || !contractAddress) {
      setState({ loading: false, error: error ?? new Error("Spot CLOB address is not configured") });
      return;
    }
    setState({ loading: true, error: null });
    try {
      const [baseExchange, baseWallet, quoteExchange, quoteWallet] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          {
            address: contractAddress,
            abi: clobAbi,
            functionName: "balanceOf",
            args: [tradingAddress, pool.data.baseAsset],
          },
          { address: pool.data.baseAsset, abi: erc20Abi, functionName: "balanceOf", args: [tradingAddress] },
          {
            address: contractAddress,
            abi: clobAbi,
            functionName: "balanceOf",
            args: [tradingAddress, pool.data.quoteAsset],
          },
          { address: pool.data.quoteAsset, abi: erc20Abi, functionName: "balanceOf", args: [tradingAddress] },
        ],
      });
      const readBalance = (
        asset: Address,
        symbol: string,
        decimals: number,
        exchange: readonly [bigint, bigint, bigint],
        walletRaw: bigint,
      ): TokenBalance => {
        const [, lockedRaw] = exchange as readonly [bigint, bigint, bigint];
        const freeRaw = walletRaw;
        const totalRaw = walletRaw + lockedRaw;
        return {
          asset,
          symbol,
          decimals,
          freeRaw,
          lockedRaw,
          totalRaw,
          walletRaw,
          free: formatQuote(freeRaw, { ...pool.data, quoteDecimals: decimals } as PoolMetadata),
          locked: formatQuote(lockedRaw, { ...pool.data, quoteDecimals: decimals } as PoolMetadata),
          total: formatQuote(totalRaw, { ...pool.data, quoteDecimals: decimals } as PoolMetadata),
          wallet: formatQuote(walletRaw, { ...pool.data, quoteDecimals: decimals } as PoolMetadata),
        };
      };
      const base = readBalance(
        pool.data.baseAsset,
        pool.data.baseSymbol,
        pool.data.baseDecimals,
        baseExchange,
        baseWallet,
      );
      const quote = readBalance(
        pool.data.quoteAsset,
        pool.data.quoteSymbol,
        pool.data.quoteDecimals,
        quoteExchange,
        quoteWallet,
      );
      setData({ base, quote });
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error: toError(error) });
    }
  }, [authenticated, pool.data, publicClient, tradingAddress]);
  useEffect(() => {
    void refetch();
    return subscribeToBalanceRefresh(() => void refetch());
  }, [refetch]);
  return { data, error: state.error ?? pool.error, loading: state.loading || pool.loading, refetch };
}

function orderStatus(status: number): OpenOrder["status"] {
  if (status === 1) return "open";
  if (status === 2) return "partially-filled";
  if (status === 3) return "filled";
  return "cancelled";
}

export function useUserOrders(poolId?: PoolId) {
  const { config, eventClient, publicClient } = useClobChain();
  const pool = usePoolMetadata(poolId);
  const { authenticated, tradingAddress } = useClobWallet();
  const [data, setData] = useState<OpenOrder[]>([]);
  const [openData, setOpenData] = useState<OpenOrder[]>([]);
  const [state, setState] = useState<AsyncState>(EMPTY_ASYNC);
  const refreshes = useRef(createRequestCoalescer<string, void>());
  const loadedRequestKey = useRef<string | null>(null);
  const knownOrderIds = useRef(new Set<PoolId>());

  const refetch = useCallback(() => {
    const requestKey = `${poolId ?? "none"}:${pool.data?.clobAddress ?? "none"}:${tradingAddress ?? "none"}`;
    return refreshes.current.run(requestKey, async () => {
      if (!poolId || !pool.data || !tradingAddress || !authenticated) {
        setData([]);
        setOpenData([]);
        loadedRequestKey.current = null;
        knownOrderIds.current.clear();
        setState(EMPTY_ASYNC);
        return;
      }
      const contractAddress = pool.data.clobAddress;
      const error = clobError(contractAddress);
      if (error || !contractAddress) {
        setState({ loading: false, error: error ?? new Error("Spot CLOB address is not configured") });
        return;
      }
      const isInitialLoad = loadedRequestKey.current !== requestKey;
      if (isInitialLoad) setState({ loading: true, error: null });
      try {
        const metadata = pool.data;
        const lensAddress = config.lensAddress;
        if (!lensAddress && !metadata.legacyFactory) {
          throw new Error("The CLOB lens is not configured for this network");
        }
        type UserOrderResult = readonly [
          readonly {
            orderId: PoolId;
            order: {
              side: number;
              price: bigint;
              quantity: bigint;
              expiry: bigint;
              clientOrderId: bigint;
            };
            state: {
              filledQuantity: bigint;
              createdAt: bigint;
              status: number;
              kind: number;
              filledQuoteQuantity: bigint;
            };
          }[],
          PoolId,
        ];

        const walletAddress = tradingAddress;
        const zeroCursor = `0x${"0".repeat(64)}` as PoolId;
        const readOrderIds = async (statusFlags: number) => {
          const orderIds: PoolId[] = [];
          let cursor = zeroCursor;
          do {
            const [page, nextCursor] = await publicClient.readContract({
              address: contractAddress,
              abi: clobAbi,
              functionName: "getUserOrderIds",
              args: [poolId, walletAddress, cursor, 256, statusFlags],
            });
            orderIds.push(...page);
            cursor = nextCursor;
          } while (cursor !== zeroCursor);
          return orderIds;
        };
        const readOrders = async (): Promise<UserOrderResult[0]> => {
          if (metadata.legacyFactory) {
            const orderIds = await readOrderIds(7);
            if (orderIds.length === 0) return [];
            const results = (await publicClient.multicall({
              allowFailure: false,
              contracts: orderIds.map((orderId) => ({
                address: contractAddress,
                abi: clobAbi,
                functionName: "getOrder" as const,
                args: [orderId],
              })),
            })) as unknown as readonly (readonly [
              UserOrderResult[0][number]["order"],
              UserOrderResult[0][number]["state"],
            ])[];
            return results.map(([order, orderState], index) => ({
              orderId: orderIds[index],
              order,
              state: orderState,
            }));
          }

          const records: UserOrderResult[0][number][] = [];
          let cursor = zeroCursor;
          do {
            const [page, nextCursor] = (await publicClient.readContract({
              address: lensAddress as Address,
              abi: clobLensAbi,
              functionName: "getUserOrders",
              args: [contractAddress, poolId, walletAddress, cursor, 256, 7],
            })) as UserOrderResult;
            records.push(...page);
            cursor = nextCursor;
          } while (cursor !== zeroCursor);
          return records;
        };
        const [records, openOrderIds] = await Promise.all([readOrders(), readOrderIds(1)]);

        const orders: OpenOrder[] = records.map(({ orderId, order, state: orderState }) => ({
          orderId,
          side: order.side === 0 ? "buy" : "sell",
          kind: orderState.kind === 1 ? "market" : "limit",
          priceRaw: order.price,
          quantityLots: order.quantity,
          filledQuantityLots: orderState.filledQuantity,
          filledQuoteQuantity: orderState.filledQuoteQuantity,
          price: formatPrice(order.price, metadata),
          quantity: formatQuantity(order.quantity, metadata),
          filled: formatQuantity(orderState.filledQuantity, metadata),
          remaining: formatQuantity(order.quantity - orderState.filledQuantity, metadata),
          status: orderStatus(orderState.status),
          createdAt: orderState.createdAt,
          expiry: order.expiry,
          clientOrderId: order.clientOrderId,
        }));
        const openOrderSet = new Set(openOrderIds);
        knownOrderIds.current = new Set(orders.map((order) => order.orderId));
        setData(orders);
        setOpenData(orders.filter((order) => openOrderSet.has(order.orderId)));
        loadedRequestKey.current = requestKey;
        setState({ loading: false, error: null });
      } catch (error) {
        setState({ loading: false, error: toError(error) });
      }
    });
  }, [authenticated, config.lensAddress, pool.data, poolId, publicClient, tradingAddress]);

  useEffect(() => {
    void refetch();
    const contractAddress = pool.data?.clobAddress;
    if (!eventClient || !poolId || !contractAddress || !tradingAddress) return;
    const refreshOnError = () => void refetch();
    const subscriptions = [
      eventClient.watchContractEvent({
        address: contractAddress,
        abi: clobAbi,
        eventName: "OrderPlaced",
        args: { poolId, trader: tradingAddress },
        onLogs: () => void refetch(),
        onError: refreshOnError,
      }),
      eventClient.watchContractEvent({
        address: contractAddress,
        abi: clobAbi,
        eventName: "OrderCancelled",
        args: { poolId, trader: tradingAddress },
        onLogs: () => void refetch(),
        onError: refreshOnError,
      }),
      ...(["OrderFilled", "OrderPartiallyFilled"] as const).map((eventName) =>
        eventClient.watchContractEvent({
          address: contractAddress,
          abi: clobAbi,
          eventName,
          args: { poolId },
          onLogs: (logs) => {
            if (logs.some((log) => log.args.orderId && knownOrderIds.current.has(log.args.orderId))) void refetch();
          },
          onError: refreshOnError,
        }),
      ),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [eventClient, pool.data?.clobAddress, poolId, refetch, tradingAddress]);

  return {
    data,
    openData,
    error: state.error ?? pool.error,
    loading: state.loading || (loadedRequestKey.current === null && pool.loading),
    refetch,
  };
}

export function useOpenOrders(poolId?: PoolId) {
  const orders = useUserOrders(poolId);
  return { ...orders, data: orders.openData };
}
