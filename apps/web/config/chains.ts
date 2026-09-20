import { type Address, type Chain, defineChain } from "viem";
import { monadTestnet } from "viem/chains";

import { ANVIL_CHAIN_ID, MONAD_TESTNET_CHAIN_ID } from "./constants";
import { type ContractTokenConfig, clobContractsByChainId, type FaucetTokenConfig } from "./contracts";

export type ClobRpcEndpoint = {
  url: string;
  batch: boolean;
};

const anvilRpcUrl = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545";
const monadTestnetWsRpcUrl = process.env.NEXT_PUBLIC_MONAD_WS_RPC_URL || "wss://testnet-rpc.monad.xyz";

const defaultMonadTestnetRpcEndpoints: readonly ClobRpcEndpoint[] = [
  { url: "https://testnet-rpc.monad.xyz", batch: true },
  { url: "https://rpc.ankr.com/monad_testnet", batch: true },
  { url: "https://rpc-testnet.monadinfra.com", batch: false },
  { url: "https://monad-testnet.drpc.org", batch: true },
  { url: "https://lb.routeme.sh/rpc/evm/10143", batch: true },
  { url: "https://monad-testnet.gateway.tatum.io", batch: true },
  { url: "https://monad-testnet-rpc.huginn.tech", batch: true },
];

function parseRpcUrls(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//.test(url));
}

function monadRpcEndpoints(): readonly ClobRpcEndpoint[] {
  const configured = parseRpcUrls(process.env.NEXT_PUBLIC_MONAD_RPC_URLS);
  const legacyPrimary = parseRpcUrls(process.env.NEXT_PUBLIC_MONAD_RPC_URL);
  const urls = configured.length
    ? configured
    : [...legacyPrimary, ...defaultMonadTestnetRpcEndpoints.map((endpoint) => endpoint.url)];
  const defaults = new Map(defaultMonadTestnetRpcEndpoints.map((endpoint) => [endpoint.url, endpoint]));
  return [...new Set(urls)].map((url) => defaults.get(url) ?? { url, batch: true });
}

const monadTestnetRpcEndpoints = monadRpcEndpoints();
const monadTestnetRpcUrl = monadTestnetRpcEndpoints[0]?.url ?? defaultMonadTestnetRpcEndpoints[0].url;
const anvilRpcEndpoints: readonly ClobRpcEndpoint[] = [{ url: anvilRpcUrl, batch: true }];

export const anvilChain = defineChain({
  id: ANVIL_CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [anvilRpcUrl] } },
});

export const monadTestnetChain = defineChain({
  ...monadTestnet,
  rpcUrls: { default: { http: monadTestnetRpcEndpoints.map((endpoint) => endpoint.url) } },
  blockExplorers: {
    default: { name: "Monadscan", url: "https://testnet.monadscan.com" },
  },
});

function optionalBytes32(value: string | undefined): `0x${string}` | undefined {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : undefined;
}

export type ClobNetworkConfig = {
  chain: Chain;
  rpcUrl: string;
  rpcEndpoints: readonly ClobRpcEndpoint[];
  wsRpcUrl?: string;
  factoryAddress?: Address;
  lensAddress?: Address;
  tokenFactoryAddress?: Address;
  faucetAddress?: Address;
  tokens: readonly ContractTokenConfig[];
  faucetTokens: readonly FaucetTokenConfig[];
  defaultPoolId?: `0x${string}`;
  deploymentBlock: bigint;
};

export const clobNetworksByChainId: Readonly<Record<number, ClobNetworkConfig>> = {
  [MONAD_TESTNET_CHAIN_ID]: {
    chain: monadTestnetChain,
    rpcUrl: monadTestnetRpcUrl,
    rpcEndpoints: monadTestnetRpcEndpoints,
    wsRpcUrl: monadTestnetWsRpcUrl,
    ...clobContractsByChainId[MONAD_TESTNET_CHAIN_ID],
    defaultPoolId: optionalBytes32(
      process.env.NEXT_PUBLIC_MONAD_DEFAULT_POOL_ID ||
        "0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c",
    ),
    deploymentBlock: BigInt(process.env.NEXT_PUBLIC_MONAD_CLOB_DEPLOYMENT_BLOCK || "63617140"),
  },
  [ANVIL_CHAIN_ID]: {
    chain: anvilChain,
    rpcUrl: anvilRpcUrl,
    rpcEndpoints: anvilRpcEndpoints,
    ...clobContractsByChainId[ANVIL_CHAIN_ID],
    defaultPoolId: optionalBytes32(process.env.NEXT_PUBLIC_DEFAULT_POOL_ID),
    deploymentBlock: BigInt(process.env.NEXT_PUBLIC_CLOB_DEPLOYMENT_BLOCK || "0"),
  },
};

export const supportedClobChainIds = [MONAD_TESTNET_CHAIN_ID, ANVIL_CHAIN_ID] as const;
export const supportedClobNetworks = supportedClobChainIds.map((chainId) => clobNetworksByChainId[chainId]);

export function isSupportedClobChainId(chainId: number): chainId is (typeof supportedClobChainIds)[number] {
  return supportedClobChainIds.some((supported) => supported === chainId);
}

export function getClobNetwork(chainId: number): ClobNetworkConfig {
  const network = clobNetworksByChainId[chainId];
  if (!network) throw new Error(`Unsupported CLOB chain: ${chainId}`);
  return network;
}

export function configurationError(config: ClobNetworkConfig) {
  return config.factoryAddress ? undefined : new Error(`CLOB factory is not configured for ${config.chain.name}`);
}
