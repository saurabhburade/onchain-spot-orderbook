import type { Address } from "viem";

import { getClobNetwork } from "@/config/chains";
import { ANVIL_CHAIN_ID, MONAD_TESTNET_CHAIN_ID } from "@/config/constants";
import { clobContractsByChainId } from "@/config/contracts";
import type { PoolId } from "./types";

export type ListedMarket = {
  poolId: PoolId;
  baseIconUrl?: string;
  quoteIconUrl?: string;
};

export type ListedQuoteToken = {
  address: Address;
  symbol: string;
  decimals: number;
  iconUrl?: string;
};

const storedMarketsKeyPrefix = "clob:listed-markets:v2";
const listedMarketsChangedEvent = "clob:listed-markets-changed";

function storedMarketsKey(chainId: number) {
  const factoryAddress = getClobNetwork(chainId).factoryAddress?.toLowerCase() ?? "unconfigured";
  return `${storedMarketsKeyPrefix}:${chainId}:${factoryAddress}`;
}

const trustWalletAssets =
  "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/monad";
const monadIconUrl = `${trustWalletAssets}/info/logo.png`;
const tetherIconUrl =
  "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png";
const monadTokens = clobContractsByChainId[MONAD_TESTNET_CHAIN_ID].tokens;
const anvilTokens = clobContractsByChainId[ANVIL_CHAIN_ID].tokens;
const monadToken = monadTokens.find((token) => token.symbol === "MON");
const monadUsdc = monadTokens.find((token) => token.symbol === "USDC");
const monadUsdt = monadTokens.find((token) => token.symbol === "USDT");
const anvilUsdc = anvilTokens.find((token) => token.symbol === "USDC");

if (!monadToken || !monadUsdc || !monadUsdt || !anvilUsdc) {
  throw new Error("Known market tokens are missing from the contract registry");
}

const tokenIconUrlsByChainId: Readonly<Partial<Record<number, Readonly<Record<string, string>>>>> = {
  [MONAD_TESTNET_CHAIN_ID]: {
    [monadToken.address.toLowerCase()]: monadIconUrl,
    [monadUsdt.address.toLowerCase()]: tetherIconUrl,
  },
};
const anvilQuoteTokens: readonly ListedQuoteToken[] = [
  {
    ...anvilUsdc,
    iconUrl: `${trustWalletAssets}/assets/0x754704Bc059F8C67012fEd69BC8A327a5aafb603/logo.png`,
  },
];
const monadQuoteTokens: readonly ListedQuoteToken[] = [
  {
    ...monadUsdc,
    iconUrl: `${trustWalletAssets}/assets/0x754704Bc059F8C67012fEd69BC8A327a5aafb603/logo.png`,
  },
];
/** Curated markets exposed by the client for each supported chain. */
export const listedMarketsByChainId: Readonly<Record<number, readonly ListedMarket[]>> = {
  [ANVIL_CHAIN_ID]: [],
  [MONAD_TESTNET_CHAIN_ID]: [],
};

/** Known quote-token choices. The factory remains the source of truth for current approval. */
export const listedQuoteTokensByChainId: Readonly<Record<number, readonly ListedQuoteToken[]>> = {
  [ANVIL_CHAIN_ID]: anvilQuoteTokens,
  [MONAD_TESTNET_CHAIN_ID]: monadQuoteTokens,
};

export function listedQuoteTokens(chainId: number): readonly ListedQuoteToken[] {
  return listedQuoteTokensByChainId[chainId] ?? [];
}

export function listedTokenIconUrl(chainId: number, address: Address): string | undefined {
  return (
    tokenIconUrlsByChainId[chainId]?.[address.toLowerCase()] ??
    listedQuoteTokens(chainId).find((token) => token.address.toLowerCase() === address.toLowerCase())?.iconUrl
  );
}

export function listedMarketIds(chainId: number): readonly PoolId[] {
  return listedMarkets(chainId).map((market) => market.poolId);
}

export function listedMarkets(chainId: number): readonly ListedMarket[] {
  const configured = [...(listedMarketsByChainId[chainId] ?? [])];
  const defaultPoolId = getClobNetwork(chainId).defaultPoolId;
  if (defaultPoolId && !configured.some((market) => market.poolId.toLowerCase() === defaultPoolId.toLowerCase())) {
    configured.push(
      chainId === ANVIL_CHAIN_ID
        ? {
            poolId: defaultPoolId,
            baseIconUrl: monadIconUrl,
            quoteIconUrl: `${trustWalletAssets}/assets/0x754704Bc059F8C67012fEd69BC8A327a5aafb603/logo.png`,
          }
        : { poolId: defaultPoolId },
    );
  }
  if (typeof window === "undefined") return configured;

  try {
    const storedPoolIds = JSON.parse(window.localStorage.getItem(storedMarketsKey(chainId)) ?? "[]") as unknown;
    const poolIds = Array.isArray(storedPoolIds)
      ? storedPoolIds.filter(
          (value: unknown): value is PoolId => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
        )
      : [];
    const markets = new Map(configured.map((market) => [market.poolId.toLowerCase(), market]));
    for (const poolId of poolIds) {
      if (!markets.has(poolId.toLowerCase())) markets.set(poolId.toLowerCase(), { poolId });
    }
    return [...markets.values()];
  } catch {
    return configured;
  }
}

/** Persist a user-created market in this browser's chain-scoped market list. */
export function addListedMarket(chainId: number, market: ListedMarket) {
  if (typeof window === "undefined") return;
  let storedPoolIds: unknown = [];
  try {
    storedPoolIds = JSON.parse(window.localStorage.getItem(storedMarketsKey(chainId)) ?? "[]") as unknown;
  } catch {
    storedPoolIds = [];
  }
  const current: unknown[] = Array.isArray(storedPoolIds) ? storedPoolIds : [];
  const poolIds = current.filter((value: unknown): value is string => typeof value === "string");
  if (!poolIds.some((poolId) => poolId.toLowerCase() === market.poolId.toLowerCase())) {
    window.localStorage.setItem(storedMarketsKey(chainId), JSON.stringify([...poolIds, market.poolId]));
  }
  window.dispatchEvent(new Event(listedMarketsChangedEvent));
}

export function subscribeToListedMarkets(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(`${storedMarketsKeyPrefix}:`)) listener();
  };
  window.addEventListener(listedMarketsChangedEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(listedMarketsChangedEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}
