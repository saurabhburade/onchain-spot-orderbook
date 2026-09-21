"use server";

import { isSupportedClobChainId } from "@/config/chains";
import type { PoolId } from "@/lib/clob";

import { fetchIndexedRecentTrades } from "./queries";
import { getIndexerGraphqlUrl } from "./server-config";

const recentTradesPageSize = 10;
const maxRecentTradesOffset = 10_000;

export async function refreshIndexedRecentTrades(input: { chainId: number; marketId: string; page: number }) {
  if (!Number.isSafeInteger(input.chainId) || !isSupportedClobChainId(input.chainId)) {
    throw new Error("Unsupported CLOB chain");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.marketId)) {
    throw new Error("Invalid market id");
  }
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 0 ||
    input.page * recentTradesPageSize > maxRecentTradesOffset
  ) {
    throw new Error("Invalid recent trades page");
  }

  return fetchIndexedRecentTrades(
    getIndexerGraphqlUrl(input.chainId),
    input.marketId as PoolId,
    input.page,
    recentTradesPageSize,
  );
}
