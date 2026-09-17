import type { ConnectedWallet } from "@privy-io/react-auth";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  type Hash,
  http,
  webSocket,
} from "viem";
import { type ClobNetworkConfig, getClobNetwork, MONAD_TESTNET_CHAIN_ID } from "./config";

const publicClients = new Map<number, ReturnType<typeof createPublicClient>>();
const eventClients = new Map<number, ReturnType<typeof createPublicClient>>();

export function getClobPublicClient(chainId: number) {
  const existing = publicClients.get(chainId);
  if (existing) return existing;
  const network = getClobNetwork(chainId);
  const transports = network.rpcEndpoints.map((endpoint) =>
    http(endpoint.url, {
      batch: endpoint.batch
        ? {
            batchSize: 50,
            wait: 16,
          }
        : undefined,
      retryCount: 0,
    }),
  );
  const client = createPublicClient({
    batch: { multicall: true },
    chain: network.chain,
    pollingInterval: chainId === MONAD_TESTNET_CHAIN_ID ? 500 : 1_000,
    transport: transports.length === 1 ? transports[0] : fallback(transports, { retryCount: 0 }),
  });
  publicClients.set(chainId, client);
  return client;
}

export function getClobEventClient(chainId: number) {
  const existing = eventClients.get(chainId);
  if (existing) return existing;
  const network = getClobNetwork(chainId);
  if (!network.wsRpcUrl) return undefined;
  const client = createPublicClient({
    chain: network.chain,
    transport: webSocket(network.wsRpcUrl),
  });
  eventClients.set(chainId, client);
  return client;
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return Number((error as { code: unknown }).code);
}

export async function switchPrivyWalletToChain(wallet: ConnectedWallet, network: ClobNetworkConfig) {
  if (wallet.chainId === `eip155:${network.chain.id}`) return;
  const provider = await wallet.getEthereumProvider();
  const chainId = `0x${network.chain.id.toString(16)}` as const;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: network.chain.name,
          nativeCurrency: network.chain.nativeCurrency,
          rpcUrls: network.rpcEndpoints.map((endpoint) => endpoint.url),
        },
      ],
    });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  }
}

export async function createPrivyWalletClient(wallet: ConnectedWallet, network: ClobNetworkConfig) {
  await switchPrivyWalletToChain(wallet, network);
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({
    account: wallet.address as Address,
    chain: network.chain,
    transport: custom(provider),
  });
}

export async function waitForTransaction(chainId: number, hash: Hash) {
  const receipt = await getClobPublicClient(chainId).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${hash} was mined but reverted`);
  }
  return receipt;
}
