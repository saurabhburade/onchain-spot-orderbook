"use client";

import { type Address, encodeFunctionData, getAddress, type Hash, isAddress } from "viem";

import { erc20Abi, poolRegistryAbi } from "@/config/abis";
import type { ClobNetworkConfig } from "@/config/chains";
import type { getClobPublicClient } from "@/config/viem";
import { createAsyncCache } from "@/lib/clob/async-cache";
import { decodePoolResultData } from "@/lib/clob/pool-metadata";
import type { AsyncState, MarketListing, MarketToken, PoolId, PoolMetadata, PriceLevel } from "@/lib/clob/types";
import { formatPrice, formatQuantity, formatQuote, quoteAmountRaw, toError } from "@/lib/clob/utils";

export const EMPTY_ASYNC: AsyncState = { loading: false, error: null };
export const RPC_LOG_BLOCK_RANGE = 100n;

export type ClobPublicClient = ReturnType<typeof getClobPublicClient>;

const poolMetadataCaches = new WeakMap<ClobPublicClient, ReturnType<typeof createAsyncCache<string, PoolMetadata>>>();

function poolMetadataCache(publicClient: ClobPublicClient) {
  const existing = poolMetadataCaches.get(publicClient);
  if (existing) return existing;
  const cache = createAsyncCache<string, PoolMetadata>();
  poolMetadataCaches.set(publicClient, cache);
  return cache;
}

const marketSnapshotCaches = new WeakMap<ClobPublicClient, Map<string, MarketListing[]>>();

export function marketSnapshotCache(publicClient: ClobPublicClient) {
  const existing = marketSnapshotCaches.get(publicClient);
  if (existing) return existing;
  const cache = new Map<string, MarketListing[]>();
  marketSnapshotCaches.set(publicClient, cache);
  return cache;
}

export function registryError(config: ClobNetworkConfig) {
  return config.factoryAddress ? undefined : new Error(`CLOB factory is not configured for ${config.chain.name}`);
}

export function clobError(contractAddress?: Address) {
  return contractAddress ? undefined : new Error("This factory pair has no deployed Spot CLOB");
}

export async function readMarketToken(publicClient: ClobPublicClient, input: string): Promise<MarketToken> {
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

export function level(priceRaw: bigint, quantityLots: bigint, pool: PoolMetadata): PriceLevel {
  const quoteRaw = quoteAmountRaw(priceRaw, quantityLots, pool);
  return {
    priceRaw,
    quantityLots,
    price: formatPrice(priceRaw, pool),
    quantity: formatQuantity(quantityLots, pool),
    quoteValue: formatQuote(quoteRaw, pool),
  };
}

export function mergeLogs<T extends { transactionHash: Hash; logIndex: number }>(current: T[], next: T[]) {
  const merged = new Map(current.map((item) => [`${item.transactionHash}:${item.logIndex}`, item]));
  for (const item of next) merged.set(`${item.transactionHash}:${item.logIndex}`, item);
  return [...merged.values()].sort((a, b) => {
    if (a.transactionHash === b.transactionHash) return a.logIndex - b.logIndex;
    return 0;
  });
}

export async function readPoolMetadata(
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

export function cachedReadPoolMetadata(publicClient: ClobPublicClient, poolId: PoolId, factoryAddress: Address) {
  const key = `${factoryAddress.toLowerCase()}:${poolId.toLowerCase()}`;
  return poolMetadataCache(publicClient).get(key, () => readPoolMetadata(publicClient, poolId, factoryAddress));
}

export async function readFactoryMarketIds(publicClient: ClobPublicClient, factoryAddress: Address): Promise<PoolId[]> {
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

export function transactionError(error: unknown) {
  return toError(error);
}
