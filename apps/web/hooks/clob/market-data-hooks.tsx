"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hash } from "viem";

import { clobAbi, clobLensAbi } from "@/config/abis";
import { createRequestCoalescer } from "@/lib/clob/async-cache";
import { useClobChain } from "@/lib/clob/chain-context";
import { getLogsInBlockRanges } from "@/lib/clob/log-ranges";
import type { AsyncState, BestPrices, OrderBook, PoolId, TradeExecuted } from "@/lib/clob/types";
import { formatPrice, formatQuantity, formatQuote, toError } from "@/lib/clob/utils";
import { usePoolMetadata } from "./market-hooks";
import { clobError, EMPTY_ASYNC, level, mergeLogs, RPC_LOG_BLOCK_RANGE } from "./shared";

export function useOrderbook(poolId?: PoolId, depth = 20) {
  const { config, eventClient, publicClient } = useClobChain();
  const pool = usePoolMetadata(poolId);
  const [data, setData] = useState<OrderBook | null>(null);
  const [state, setState] = useState<AsyncState>(EMPTY_ASYNC);
  const refreshes = useRef(createRequestCoalescer<string, void>());
  const loadedRequestKey = useRef<string | null>(null);

  const refetch = useCallback(() => {
    const requestKey = `${poolId ?? "none"}:${pool.data?.clobAddress ?? "none"}:${depth}`;
    return refreshes.current.run(requestKey, async () => {
      if (!poolId || !pool.data) {
        setData(null);
        loadedRequestKey.current = null;
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
        const rawDepth = BigInt(depth) as unknown as number;
        const [bids, asks] =
          config.lensAddress && !pool.data.legacyFactory
            ? await publicClient
                .readContract({
                  address: config.lensAddress,
                  abi: clobLensAbi,
                  functionName: "getMarketSnapshot",
                  args: [contractAddress, pool.data.baseAsset, pool.data.quoteAsset, rawDepth],
                })
                .then((snapshot) => [snapshot.bids, snapshot.asks] as const)
            : await publicClient.readContract({
                address: contractAddress,
                abi: clobAbi,
                functionName: "getOrderBook",
                args: [poolId, rawDepth],
              });
        const metadata = pool.data;
        if (!metadata) throw new Error("Pool metadata became unavailable while reading the order book");
        setData({
          bids: bids.map((item) => level(item.price, item.quantity, metadata)),
          asks: asks.map((item) => level(item.price, item.quantity, metadata)),
        });
        loadedRequestKey.current = requestKey;
        setState({ loading: false, error: null });
      } catch (error) {
        setState({ loading: false, error: toError(error) });
      }
    });
  }, [config.lensAddress, depth, pool.data, poolId, publicClient]);

  useEffect(() => {
    void refetch();
    const contractAddress = pool.data?.clobAddress;
    if (!eventClient || !poolId || !contractAddress) return;
    return eventClient.watchContractEvent({
      address: contractAddress,
      abi: clobAbi,
      eventName: "BookUpdated",
      args: { poolId },
      onLogs: () => void refetch(),
      onError: () => void refetch(),
    });
  }, [eventClient, pool.data?.clobAddress, poolId, refetch]);

  return {
    data,
    error: state.error ?? pool.error,
    loading: state.loading || (loadedRequestKey.current === null && pool.loading),
    refetch,
  };
}

export function useBestPrices(poolId?: PoolId) {
  const { config, eventClient, publicClient } = useClobChain();
  const pool = usePoolMetadata(poolId);
  const [data, setData] = useState<BestPrices | null>(null);
  const [state, setState] = useState<AsyncState>(EMPTY_ASYNC);
  const refetch = useCallback(async () => {
    if (!poolId || !pool.data) {
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
      const result =
        config.lensAddress && !pool.data.legacyFactory
          ? await publicClient
              .readContract({
                address: config.lensAddress,
                abi: clobLensAbi,
                functionName: "getMarketSnapshot",
                args: [contractAddress, pool.data.baseAsset, pool.data.quoteAsset, 0],
              })
              .then(
                (snapshot) =>
                  [
                    snapshot.bidExists,
                    snapshot.bidPrice,
                    snapshot.bidQuantity,
                    snapshot.askExists,
                    snapshot.askPrice,
                    snapshot.askQuantity,
                  ] as const,
              )
          : await publicClient.readContract({
              address: contractAddress,
              abi: clobAbi,
              functionName: "getBestPrices",
              args: [poolId],
            });
      setData({
        bid: result[0] ? level(result[1], result[2], pool.data) : null,
        ask: result[3] ? level(result[4], result[5], pool.data) : null,
      });
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error: toError(error) });
    }
  }, [config.lensAddress, pool.data, poolId, publicClient]);
  useEffect(() => {
    void refetch();
    const contractAddress = pool.data?.clobAddress;
    if (!eventClient || !poolId || !contractAddress) return;
    return eventClient.watchContractEvent({
      address: contractAddress,
      abi: clobAbi,
      eventName: "BookUpdated",
      args: { poolId },
      onLogs: () => void refetch(),
      onError: () => void refetch(),
    });
  }, [eventClient, pool.data?.clobAddress, poolId, refetch]);
  return { data, error: state.error ?? pool.error, loading: state.loading || pool.loading, refetch };
}

export function useTradeExecuted(poolId?: PoolId) {
  const { config, eventClient, publicClient } = useClobChain();
  const pool = usePoolMetadata(poolId);
  const [data, setData] = useState<TradeExecuted[]>([]);
  const [state, setState] = useState<AsyncState>(EMPTY_ASYNC);

  const decode = useCallback(
    (log: {
      args: {
        poolId?: PoolId;
        takerOrderId?: PoolId;
        makerOrderId?: PoolId;
        baseAsset?: Address;
        quoteAsset?: Address;
        price?: bigint;
        quantity?: bigint;
        quoteQuantity?: bigint;
      };
      blockNumber: bigint | null;
      transactionHash: Hash;
      logIndex: number;
    }): TradeExecuted => {
      if (
        !pool.data ||
        !log.args.poolId ||
        !log.args.takerOrderId ||
        !log.args.makerOrderId ||
        !log.args.baseAsset ||
        !log.args.quoteAsset ||
        log.args.price === undefined ||
        log.args.quantity === undefined ||
        log.args.quoteQuantity === undefined
      ) {
        throw new Error("Malformed TradeExecuted log");
      }
      return {
        poolId: log.args.poolId,
        takerOrderId: log.args.takerOrderId,
        makerOrderId: log.args.makerOrderId,
        baseAsset: log.args.baseAsset,
        quoteAsset: log.args.quoteAsset,
        priceRaw: log.args.price,
        quantityLots: log.args.quantity,
        quoteQuantityRaw: log.args.quoteQuantity,
        price: formatPrice(log.args.price, pool.data),
        quantity: formatQuantity(log.args.quantity, pool.data),
        quoteQuantity: formatQuote(log.args.quoteQuantity, pool.data),
        timestamp: 0n,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      };
    },
    [pool.data],
  );
  const blockTimestampCache = useRef(new Map<bigint, bigint>());

  const enrichTimestamps = useCallback(
    async (trades: TradeExecuted[]) => {
      return Promise.all(
        trades.map(async (trade) => {
          if (trade.blockNumber === null) throw new Error("TradeExecuted log has no mined block");
          let timestamp = blockTimestampCache.current.get(trade.blockNumber);
          if (timestamp === undefined) {
            const block = await publicClient.getBlock({ blockNumber: trade.blockNumber });
            timestamp = block.timestamp;
            blockTimestampCache.current.set(trade.blockNumber, timestamp);
          }
          return { ...trade, timestamp };
        }),
      );
    },
    [publicClient],
  );

  const refetch = useCallback(async () => {
    if (!poolId || !pool.data) {
      setData([]);
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
      const logs = await getLogsInBlockRanges(
        () => publicClient.getBlockNumber(),
        ({ fromBlock, toBlock }) =>
          publicClient.getLogs({
            address: contractAddress,
            event: clobAbi.find((item) => item.type === "event" && item.name === "TradeExecuted"),
            args: { poolId },
            fromBlock,
            toBlock,
          }),
        config.deploymentBlock,
        RPC_LOG_BLOCK_RANGE,
      );
      setData(await enrichTimestamps(logs.map((log) => decode(log as Parameters<typeof decode>[0]))));
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error: toError(error) });
    }
  }, [config.deploymentBlock, decode, enrichTimestamps, pool.data, poolId, publicClient]);

  useEffect(() => {
    void refetch();
    const contractAddress = pool.data?.clobAddress;
    if (!eventClient || !poolId || !contractAddress) return;
    return eventClient.watchContractEvent({
      address: contractAddress,
      abi: clobAbi,
      eventName: "TradeExecuted",
      args: { poolId },
      onLogs: (logs) => {
        try {
          const decoded = logs.map((log) => decode(log as Parameters<typeof decode>[0]));
          void enrichTimestamps(decoded)
            .then((enriched) => setData((current) => mergeLogs(current, enriched)))
            .catch((error) => setState({ loading: false, error: toError(error) }));
        } catch (error) {
          setState({ loading: false, error: toError(error) });
        }
      },
      onError: () => void refetch(),
    });
  }, [decode, enrichTimestamps, eventClient, pool.data?.clobAddress, poolId, refetch]);

  return { data, error: state.error ?? pool.error, loading: state.loading || pool.loading, refetch };
}
