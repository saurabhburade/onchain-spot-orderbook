"use client";

import { useAuthorizationSignature, usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  isAddress,
  parseUnits,
  zeroAddress,
} from "viem";

import { clobAbi, clobLensAbi, erc20Abi, poolRegistryAbi } from "@/config/abis";
import type { ClobNetworkConfig } from "@/config/chains";
import { ANVIL_CHAIN_ID, MONAD_TESTNET_CHAIN_ID } from "@/config/constants";
import { createPrivyWalletClient, type getClobPublicClient, waitForTransaction } from "@/config/viem";
import { createAsyncCache, createRequestCoalescer } from "@/lib/clob/async-cache";
import { type AtomicCall, encodeAtomicBatch } from "@/lib/clob/atomic-batch";
import { useClobChain } from "@/lib/clob/chain-context";
import {
  AGNOSTIC_CREATE_PAIR_SELECTOR,
  hasFunctionSelector,
  isUnsupportedContractFunctionError,
  LEGACY_CREATE_PAIR_SELECTOR,
  legacyCreatePairArgs,
} from "@/lib/clob/factory-compat";
import { getLogsInBlockRanges } from "@/lib/clob/log-ranges";
import { addListedMarket, listedMarkets, listedTokenIconUrl, subscribeToListedMarkets } from "@/lib/clob/market-list";
import { decodePoolResultData } from "@/lib/clob/pool-metadata";
import { sendPrivySponsoredCalls, waitForPrivyTransaction } from "@/lib/clob/privy-wallet-api";
import { headlessTransactionOptions } from "@/lib/clob/transaction-options";
import type {
  AnvilFaucetInput,
  AsyncState,
  BestPrices,
  CreatedMarket,
  CreateMarketInput,
  LimitOrderInput,
  MarketListing,
  MarketOrderInput,
  MarketToken,
  OpenOrder,
  OrderBook,
  PoolId,
  PoolMetadata,
  PriceLevel,
  TokenBalance,
  TradeExecuted,
  TransactionState,
} from "@/lib/clob/types";
import {
  formatPrice,
  formatQuantity,
  formatQuote,
  parsePriceToRaw,
  parseQuantityToLots,
  quoteAmountRaw,
  quoteAmountWithPoolFee,
  toError,
} from "@/lib/clob/utils";
import { useClobWallet } from "@/lib/clob/wallet";

const EMPTY_ASYNC: AsyncState = { loading: false, error: null };
const RPC_LOG_BLOCK_RANGE = 100n;

type ClobPublicClient = ReturnType<typeof getClobPublicClient>;

const poolMetadataCaches = new WeakMap<ClobPublicClient, ReturnType<typeof createAsyncCache<string, PoolMetadata>>>();

function poolMetadataCache(publicClient: ClobPublicClient) {
  const existing = poolMetadataCaches.get(publicClient);
  if (existing) return existing;
  const cache = createAsyncCache<string, PoolMetadata>();
  poolMetadataCaches.set(publicClient, cache);
  return cache;
}

const marketSnapshotCaches = new WeakMap<ClobPublicClient, Map<string, MarketListing[]>>();

function marketSnapshotCache(publicClient: ClobPublicClient) {
  const existing = marketSnapshotCaches.get(publicClient);
  if (existing) return existing;
  const cache = new Map<string, MarketListing[]>();
  marketSnapshotCaches.set(publicClient, cache);
  return cache;
}

function registryError(config: ClobNetworkConfig) {
  return config.factoryAddress ? undefined : new Error(`CLOB factory is not configured for ${config.chain.name}`);
}

function clobError(contractAddress?: Address) {
  return contractAddress ? undefined : new Error("This factory pair has no deployed Spot CLOB");
}

async function readMarketToken(publicClient: ClobPublicClient, input: string): Promise<MarketToken> {
  if (!isAddress(input)) throw new Error("Enter a valid token address");
  const address = getAddress(input);
  const bytecode = await publicClient.getBytecode({ address });
  if (!bytecode || bytecode === "0x") throw new Error("No contract is deployed at this address on the selected chain");

  try {
    const [symbolResult, decimalsResult, nameResult] = await publicClient.multicall({
      allowFailure: true,
      contracts: [
        { address, abi: erc20Abi, functionName: "symbol" },
        { address, abi: erc20Abi, functionName: "decimals" },
        { address, abi: erc20Abi, functionName: "name" },
      ],
    });
    if (symbolResult.status === "failure" || decimalsResult.status === "failure") {
      throw symbolResult.status === "failure" ? symbolResult.error : decimalsResult.error;
    }
    const symbol = symbolResult.result;
    const decimals = decimalsResult.result;
    const tokenName = nameResult.status === "success" ? nameResult.result : "";
    const normalizedSymbol = symbol.trim();
    if (!normalizedSymbol) throw new Error("Token symbol is empty");
    return {
      address,
      name: tokenName.trim() || normalizedSymbol,
      symbol: normalizedSymbol,
      decimals,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Token symbol is empty") throw error;
    throw new Error("This contract does not expose readable ERC-20 symbol and decimals", { cause: error });
  }
}

function level(priceRaw: bigint, quantityLots: bigint, pool: PoolMetadata): PriceLevel {
  const quoteRaw = quoteAmountRaw(priceRaw, quantityLots, pool);
  return {
    priceRaw,
    quantityLots,
    price: formatPrice(priceRaw, pool),
    quantity: formatQuantity(quantityLots, pool),
    quoteValue: formatQuote(quoteRaw, pool),
  };
}

function mergeLogs<T extends { transactionHash: Hash; logIndex: number }>(current: T[], next: T[]) {
  const merged = new Map(current.map((item) => [`${item.transactionHash}:${item.logIndex}`, item]));
  for (const item of next) merged.set(`${item.transactionHash}:${item.logIndex}`, item);
  return [...merged.values()].sort((a, b) => {
    if (a.transactionHash === b.transactionHash) return a.logIndex - b.logIndex;
    return 0;
  });
}

async function readPoolMetadata(
  publicClient: ClobPublicClient,
  poolId: PoolId,
  factoryAddress: Address,
): Promise<PoolMetadata> {
  const callData = encodeFunctionData({ abi: poolRegistryAbi, functionName: "getPool", args: [poolId] });
  const response = await publicClient.call({ to: factoryAddress, data: callData });
  if (!response.data) throw new Error(`Pool registry ${factoryAddress} returned no data`);
  const rawPool = decodePoolResultData(response.data);
  if (!rawPool.exists) throw new Error(`Pool ${poolId} does not exist`);
  if (/^0x0{40}$/i.test(rawPool.book)) throw new Error(`Pool ${poolId} has no deployed order book`);
  const [baseDecimals, quoteDecimals, baseSymbol, quoteSymbol] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: rawPool.baseAsset, abi: erc20Abi, functionName: "decimals" },
      { address: rawPool.quoteAsset, abi: erc20Abi, functionName: "decimals" },
      { address: rawPool.baseAsset, abi: erc20Abi, functionName: "symbol" },
      { address: rawPool.quoteAsset, abi: erc20Abi, functionName: "symbol" },
    ],
  });
  return {
    poolId,
    clobAddress: rawPool.book,
    baseAsset: rawPool.baseAsset,
    quoteAsset: rawPool.quoteAsset,
    baseSymbol,
    quoteSymbol,
    baseDecimals,
    quoteDecimals,
    lotSize: rawPool.lotSize,
    tickSize: rawPool.tickSize,
    minTick: rawPool.minTick,
    maxTick: rawPool.maxTick,
    tradingFeeBps: rawPool.tradingFeeBps,
    agnosticPricing: rawPool.agnosticPricing,
    legacyFactory: rawPool.legacyFactory,
  };
}

function cachedReadPoolMetadata(publicClient: ClobPublicClient, poolId: PoolId, factoryAddress: Address) {
  const key = `${factoryAddress.toLowerCase()}:${poolId.toLowerCase()}`;
  return poolMetadataCache(publicClient).get(key, () => readPoolMetadata(publicClient, poolId, factoryAddress));
}

async function readFactoryMarketIds(publicClient: ClobPublicClient, factoryAddress: Address): Promise<PoolId[]> {
  const pairCount = await publicClient.readContract({
    address: factoryAddress,
    abi: poolRegistryAbi,
    functionName: "allPairsLength",
  });
  if (pairCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Factory ${factoryAddress} returned too many markets to display`);
  }
  if (pairCount === 0n) return [];

  return (await publicClient.multicall({
    allowFailure: false,
    contracts: Array.from({ length: Number(pairCount) }, (_, index) => ({
      address: factoryAddress,
      abi: poolRegistryAbi,
      functionName: "pairAt" as const,
      args: [BigInt(index)] as const,
    })),
  })) as PoolId[];
}

export function usePoolMetadata(poolId?: PoolId) {
  const { config, publicClient } = useClobChain();
  const [data, setData] = useState<PoolMetadata | null>(null);
  const [state, setState] = useState<AsyncState>(EMPTY_ASYNC);

  const refetch = useCallback(async () => {
    if (!poolId) {
      setData(null);
      return;
    }
    const error = registryError(config);
    const registryAddress = config.factoryAddress;
    if (error || !registryAddress) {
      setState({ loading: false, error: error ?? new Error("Pool registry address is not configured") });
      return;
    }
    setState({ loading: true, error: null });
    try {
      setData(await cachedReadPoolMetadata(publicClient, poolId, registryAddress));
      setState({ loading: false, error: null });
    } catch (error) {
      setData(null);
      setState({ loading: false, error: toError(error) });
    }
  }, [config, poolId, publicClient]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, ...state, refetch };
}

export function useMarkets() {
  const { chainId, config, eventClient, publicClient } = useClobChain();
  const snapshotKey = `${chainId}:${config.factoryAddress?.toLowerCase() ?? "unconfigured"}`;
  const cachedSnapshot = marketSnapshotCache(publicClient).get(snapshotKey);
  const [data, setData] = useState<MarketListing[]>(() => cachedSnapshot ?? []);
  const [state, setState] = useState<AsyncState>({ loading: cachedSnapshot === undefined, error: null });

  const refetch = useCallback(async () => {
    const error = registryError(config);
    const factoryAddress = config.factoryAddress;
    if (error || !factoryAddress) {
      setState({ loading: false, error: error ?? new Error("Spot CLOB factory is not configured") });
      return;
    }
    setState({ loading: true, error: null });
    try {
      const configuredMarkets = listedMarkets(chainId);
      const configuredMarketsById = new Map(configuredMarkets.map((market) => [market.poolId.toLowerCase(), market]));
      const discoveredMarketIds = await readFactoryMarketIds(publicClient, factoryAddress);
      const marketIds = new Map(discoveredMarketIds.map((poolId) => [poolId.toLowerCase(), poolId]));
      for (const market of configuredMarkets) marketIds.set(market.poolId.toLowerCase(), market.poolId);
      const metadata = await Promise.all(
        [...marketIds.values()].map((poolId) => cachedReadPoolMetadata(publicClient, poolId, factoryAddress)),
      );
      const prices =
        metadata.length === 0
          ? []
          : ((await publicClient.multicall({
              allowFailure: false,
              contracts: metadata.map((market) => ({
                address: market.clobAddress,
                abi: clobAbi,
                functionName: "getBestPrices" as const,
                args: [market.poolId],
              })),
            })) as (readonly [boolean, bigint, bigint, boolean, bigint, bigint])[]);
      const markets = metadata.map((market, index) => {
        const marketPrices = prices[index];
        const configuredMarket = configuredMarketsById.get(market.poolId.toLowerCase());
        return {
          ...market,
          baseIconUrl: configuredMarket?.baseIconUrl ?? listedTokenIconUrl(chainId, market.baseAsset),
          quoteIconUrl: configuredMarket?.quoteIconUrl ?? listedTokenIconUrl(chainId, market.quoteAsset),
          bestBid: marketPrices[0] ? formatPrice(marketPrices[1], market) : null,
          bestAsk: marketPrices[3] ? formatPrice(marketPrices[4], market) : null,
        } satisfies MarketListing;
      });
      marketSnapshotCache(publicClient).set(snapshotKey, markets);
      setData(markets);
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error: toError(error) });
    }
  }, [chainId, config, publicClient, snapshotKey]);

  useEffect(() => {
    if (!marketSnapshotCache(publicClient).has(snapshotKey)) void refetch();
    const unsubscribeListedMarkets = subscribeToListedMarkets(() => void refetch());
    const factoryAddress = config.factoryAddress;
    if (!eventClient || !factoryAddress) return unsubscribeListedMarkets;
    const unsubscribeFactory = eventClient.watchContractEvent({
      address: factoryAddress,
      abi: poolRegistryAbi,
      eventName: "PairCreated",
      onLogs: () => void refetch(),
      onError: () => void refetch(),
    });
    return () => {
      unsubscribeListedMarkets();
      unsubscribeFactory();
    };
  }, [config.factoryAddress, eventClient, publicClient, refetch, snapshotKey]);

  return { data, ...state, refetch };
}

export function useCreateMarket() {
  const { chainId, config, publicClient } = useClobChain();
  const { authenticated, connect, ready, wallet } = useClobWallet();
  const { sendTransaction } = useSendTransaction();
  const [transaction, setTransaction] = useState<TransactionState>({ status: "idle", loading: false, error: null });

  const inspectToken = useCallback((tokenInput: string) => readMarketToken(publicClient, tokenInput), [publicClient]);

  const isQuoteTokenApproved = useCallback(
    async (tokenInput: string) => {
      const factoryAddress = config.factoryAddress;
      if (!factoryAddress) throw registryError(config);
      if (!isAddress(tokenInput)) throw new Error("Enter a valid quote token address");
      return publicClient.readContract({
        address: factoryAddress,
        abi: poolRegistryAbi,
        functionName: "isQuoteToken",
        args: [getAddress(tokenInput)],
      });
    },
    [config, publicClient],
  );

  const inspectPair = useCallback(
    async (baseInput: string, quoteInput: string) => {
      const factoryAddress = config.factoryAddress;
      if (!factoryAddress) throw registryError(config);
      if (!isAddress(baseInput) || !isAddress(quoteInput))
        throw new Error("Enter valid base and quote token addresses");
      const baseAsset = getAddress(baseInput);
      const quoteAsset = getAddress(quoteInput);
      if (baseAsset === quoteAsset) throw new Error("Base and quote tokens must be different");

      const [base, quote, pairState] = await Promise.all([
        readMarketToken(publicClient, baseInput),
        readMarketToken(publicClient, quoteInput),
        publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: factoryAddress, abi: poolRegistryAbi, functionName: "isQuoteToken", args: [quoteAsset] },
            { address: factoryAddress, abi: poolRegistryAbi, functionName: "getPair", args: [baseAsset, quoteAsset] },
          ],
        }),
      ]);
      const [quoteAllowed, existingBook] = pairState;
      if (!quoteAllowed) throw new Error(`${quote.symbol} is not approved as a quote token by the factory`);
      if (existingBook !== zeroAddress) throw new Error(`${base.symbol}/${quote.symbol} already has a market`);

      return { base, quote, legacyFactory: false };
    },
    [config, publicClient],
  );

  const createMarket = useCallback(
    async (input: CreateMarketInput): Promise<CreatedMarket> => {
      const factoryAddress = config.factoryAddress;
      if (!factoryAddress) throw registryError(config);
      if (!authenticated || !ready || !wallet) throw new Error("Connect an Ethereum wallet before creating a market");
      setTransaction({ status: "pending", loading: true, error: null });
      try {
        const [factoryBytecode, creationFee] = await Promise.all([
          publicClient.getBytecode({ address: factoryAddress }),
          (async () => {
            try {
              return await publicClient.readContract({
                address: factoryAddress,
                abi: poolRegistryAbi,
                functionName: "marketCreationFee",
              });
            } catch (error) {
              if (isUnsupportedContractFunctionError(error)) return 0n;
              throw error;
            }
          })(),
        ]);
        const data = hasFunctionSelector(factoryBytecode, AGNOSTIC_CREATE_PAIR_SELECTOR)
          ? encodeFunctionData({
              abi: poolRegistryAbi,
              functionName: "createPair",
              args: [input.baseAsset, input.quoteAsset],
            })
          : hasFunctionSelector(factoryBytecode, LEGACY_CREATE_PAIR_SELECTOR)
            ? encodeFunctionData({
                abi: poolRegistryAbi,
                functionName: "createPair",
                args: legacyCreatePairArgs(input.baseAsset, input.quoteAsset),
              })
            : (() => {
                throw new Error("The configured CLOB factory does not expose a supported createPair function");
              })();
        const { hash } = await sendTransaction(
          { chainId, data, to: factoryAddress, value: creationFee },
          headlessTransactionOptions(wallet.address, chainId),
        );
        await waitForTransaction(chainId, hash);
        const [poolId, book] = await publicClient.multicall({
          allowFailure: false,
          contracts: [
            {
              address: factoryAddress,
              abi: poolRegistryAbi,
              functionName: "pairId",
              args: [input.baseAsset, input.quoteAsset],
            },
            {
              address: factoryAddress,
              abi: poolRegistryAbi,
              functionName: "getPair",
              args: [input.baseAsset, input.quoteAsset],
            },
          ],
        });
        addListedMarket(chainId, { poolId });
        setTransaction({ status: "success", loading: false, error: null, hash });
        return { poolId, book, hash };
      } catch (error) {
        const normalized = transactionError(error);
        setTransaction({ status: "error", loading: false, error: normalized });
        throw normalized;
      }
    },
    [authenticated, chainId, config, publicClient, ready, sendTransaction, wallet],
  );

  const resetTransaction = useCallback(() => setTransaction({ status: "idle", loading: false, error: null }), []);
  return {
    authenticated,
    connect,
    ready,
    wallet,
    transaction,
    inspectToken,
    isQuoteTokenApproved,
    inspectPair,
    createMarket,
    resetTransaction,
  };
}

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
          priceRaw: order.price,
          quantityLots: order.quantity,
          filledQuantityLots: orderState.filledQuantity,
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

function transactionError(error: unknown) {
  return toError(error);
}

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

  type SubmittedTransaction = { transactionId?: string; hash?: Hash; completion: Promise<Hash> };

  const run = useCallback(
    (operation: () => Promise<Hash | SubmittedTransaction>) => {
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

      if (chainId === MONAD_TESTNET_CHAIN_ID) return sendPrivyOrder(calls);

      const data = encodeAtomicBatch(calls);
      const { hash } = await sendTransaction(
        { chainId, data, to: activeWallet.address as Address },
        headlessTransactionOptions(activeWallet.address, chainId),
      );
      await waitForTransaction(chainId, hash);
      return hash;
    },
    [chainId, publicClient, sendPrivyOrder, sendTransaction, tradingAddress, wallet],
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
        if (chainId === MONAD_TESTNET_CHAIN_ID) return sendPrivyOrder([{ to: contractAddress, data }]);
        const { hash } = await sendTransaction(
          { chainId, data, to: contractAddress },
          headlessTransactionOptions(activeWallet.address, chainId),
        );
        await waitForTransaction(chainId, hash);
        return hash;
      }),
    [chainId, pool?.clobAddress, run, sendPrivyOrder, sendTransaction, tradingAddress, wallet],
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
