import type { Address } from "viem";

import { ANVIL_CHAIN_ID, getClobNetwork, MONAD_TESTNET_CHAIN_ID } from "./config";
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

const storedMarketsKey = "clob:listed-markets:v1";
const listedMarketsChangedEvent = "clob:listed-markets-changed";

const trustWalletAssets =
  "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/monad";
const monadIconUrl = `${trustWalletAssets}/info/logo.png`;
const tetherIconUrl =
  "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png";
const tokenIconUrlsByChainId: Readonly<Partial<Record<number, Readonly<Record<string, string>>>>> = {
  [MONAD_TESTNET_CHAIN_ID]: {
    ["0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541".toLowerCase()]: monadIconUrl,
    ["0xef271f6433E05757A94e28873911Af92f0D0b9f3".toLowerCase()]: tetherIconUrl,
  },
};
const anvilQuoteTokens: readonly ListedQuoteToken[] = [
  {
    address: "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82",
    symbol: "USDC",
    decimals: 6,
    iconUrl: `${trustWalletAssets}/assets/0x754704Bc059F8C67012fEd69BC8A327a5aafb603/logo.png`,
  },
];
const monadQuoteTokens: readonly ListedQuoteToken[] = [
  {
    address: "0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3",
    symbol: "USDC",
    decimals: 6,
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
    const stored = JSON.parse(window.localStorage.getItem(storedMarketsKey) ?? "{}") as Record<string, unknown>;
    const storedPoolIds = stored[String(chainId)];
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
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(window.localStorage.getItem(storedMarketsKey) ?? "{}") as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const storedPoolIds = stored[String(chainId)];
  const current: unknown[] = Array.isArray(storedPoolIds) ? storedPoolIds : [];
  const poolIds = current.filter((value: unknown): value is string => typeof value === "string");
  if (!poolIds.some((poolId) => poolId.toLowerCase() === market.poolId.toLowerCase())) {
    stored[String(chainId)] = [...poolIds, market.poolId];
    window.localStorage.setItem(storedMarketsKey, JSON.stringify(stored));
  }
  window.dispatchEvent(new Event(listedMarketsChangedEvent));
}

export function subscribeToListedMarkets(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === storedMarketsKey) listener();
  };
  window.addEventListener(listedMarketsChangedEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(listedMarketsChangedEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}
