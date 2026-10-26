import type { Address, MulticallParameters, PublicClient } from "viem";

type BalanceClient = Pick<PublicClient, "getBlockNumber" | "getBalance" | "multicall">;

export async function readPortfolioBalanceSnapshot(
  client: BalanceClient,
  account: Address,
  contracts: MulticallParameters["contracts"],
) {
  // Pin even large multicalls, which viem may split into multiple RPC requests.
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [native, results] = await Promise.all([
    client.getBalance({ address: account, blockNumber }),
    contracts.length ? client.multicall({ contracts, blockNumber }) : [],
  ]);
  return { native, results };
}
