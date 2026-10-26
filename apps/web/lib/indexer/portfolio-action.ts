"use server";

import { getAddress, isAddress } from "viem";

import { isSupportedClobChainId } from "@/config/chains";

import { requestIndexer } from "./client";
import { fetchPortfolioOrders, fetchPortfolioTrades, type PortfolioRequest } from "./portfolio-data";
import { getIndexerGraphqlUrl } from "./server-config";

type PortfolioInput = { chainId: number; account: string; page: number };

function portfolioRequest(input: PortfolioInput) {
  if (!Number.isSafeInteger(input.chainId) || !isSupportedClobChainId(input.chainId)) {
    throw new Error("Unsupported CLOB chain");
  }
  if (!isAddress(input.account)) throw new Error("Invalid trading address");
  const endpoint = getIndexerGraphqlUrl(input.chainId);
  const signal = AbortSignal.timeout(20_000);
  const request: PortfolioRequest = (query, variables) => requestIndexer(endpoint, query, variables, signal);
  return { account: getAddress(input.account), request };
}

export async function loadPortfolioOrders(input: PortfolioInput & { openOnly: boolean }) {
  if (typeof input.openOnly !== "boolean") throw new Error("Invalid order filter");
  const { account, request } = portfolioRequest(input);
  return fetchPortfolioOrders(request, account, input.page, input.openOnly);
}

export async function loadPortfolioTrades(input: PortfolioInput) {
  const { account, request } = portfolioRequest(input);
  return fetchPortfolioTrades(request, account, input.page);
}
