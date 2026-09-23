"use client";

import { usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, getAddress, type Hash, isAddress, zeroAddress } from "viem";

import { clobAbi, poolRegistryAbi } from "@/config/abis";
import { MONAD_TESTNET_CHAIN_ID } from "@/config/constants";
import { waitForTransaction } from "@/config/viem";
import { useClobChain } from "@/lib/clob/chain-context";
import type { DirectUserOperationResult } from "@/lib/clob/direct-userop-client";
import {
  AGNOSTIC_CREATE_PAIR_SELECTOR,
  hasFunctionSelector,
  isUnsupportedContractFunctionError,
  LEGACY_CREATE_PAIR_SELECTOR,
  legacyCreatePairArgs,
} from "@/lib/clob/factory-compat";
import { submitDirectUserOperationWithSessionKey } from "@/lib/clob/kernel-session-client";
import { addListedMarket, listedMarkets, listedTokenIconUrl, subscribeToListedMarkets } from "@/lib/clob/market-list";
import { headlessTransactionOptions } from "@/lib/clob/transaction-options";
import type {
  AsyncState,
  CreatedMarket,
  CreateMarketInput,
  MarketListing,
  PoolId,
  PoolMetadata,
  TransactionState,
} from "@/lib/clob/types";
import { formatPrice, toError } from "@/lib/clob/utils";
import { useClobWallet } from "@/lib/clob/wallet";

import {
  cachedReadPoolMetadata,
  EMPTY_ASYNC,
  marketSnapshotCache,
  readFactoryMarketIds,
  readMarketToken,
  registryError,
  transactionError,
} from "./shared";

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
  const { getAccessToken } = usePrivy();
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
            { address: factoryAddress, abi: poolRegistryAbi, functionName: "pairId", args: [baseAsset, quoteAsset] },
          ],
        }),
      ]);
      const [quoteAllowed, existingBook, poolId] = pairState;
      if (!quoteAllowed) throw new Error(`${quote.symbol} is not approved as a quote token by the factory`);

      return {
        base,
        quote,
        legacyFactory: false,
        existingPoolId: existingBook !== zeroAddress ? poolId : undefined,
      };
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
        const transactionRequest = { chainId, data, to: factoryAddress, value: creationFee } as const;
        let hash: Hash;
        let metrics: DirectUserOperationResult["metrics"] | undefined;
        if (chainId === MONAD_TESTNET_CHAIN_ID) {
          const accessToken = await getAccessToken();
          if (!accessToken) throw new Error("Your Privy session expired before the market could be created");
          const sender = getAddress(wallet.address);
          const result = await submitDirectUserOperationWithSessionKey<Hash>({
            accessToken,
            chainId,
            calls: [{ to: factoryAddress, data, value: creationFee }],
            sender,
            onAccountNotDelegated: async () =>
              (await sendTransaction(transactionRequest, headlessTransactionOptions(wallet.address, chainId))).hash,
          });
          if (typeof result === "string") hash = result;
          else {
            hash = result.hash;
            metrics = result.metrics;
          }
          setTransaction({ status: "submitted", loading: true, error: null, hash, metrics });
        } else {
          ({ hash } = await sendTransaction(transactionRequest, headlessTransactionOptions(wallet.address, chainId)));
        }
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
        setTransaction({ status: "success", loading: false, error: null, hash, metrics });
        return { poolId, book, hash };
      } catch (error) {
        const normalized = transactionError(error);
        setTransaction({ status: "error", loading: false, error: normalized });
        throw normalized;
      }
    },
    [authenticated, chainId, config, getAccessToken, publicClient, ready, sendTransaction, wallet],
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
