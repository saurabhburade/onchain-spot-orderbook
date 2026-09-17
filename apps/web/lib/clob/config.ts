import { type Address, type Chain, defineChain } from "viem";
import { monadTestnet } from "viem/chains";

export const ANVIL_CHAIN_ID = 31_337;
export const MONAD_TESTNET_CHAIN_ID = 10_143;
export const DEFAULT_CLOB_CHAIN_ID = MONAD_TESTNET_CHAIN_ID;

const anvilRpcUrl = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545";
const monadTestnetWsRpcUrl = process.env.NEXT_PUBLIC_MONAD_WS_RPC_URL || "wss://testnet-rpc.monad.xyz";

export type ClobRpcEndpoint = {
  url: string;
  batch: boolean;
};

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

function optionalAddress(value: string | undefined): Address | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : undefined;
}

function optionalBytes32(value: string | undefined): `0x${string}` | undefined {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : undefined;
}

export type ClobNetworkConfig = {
  chain: Chain;
  indexerGraphqlUrl: string;
  rpcUrl: string;
  rpcEndpoints: readonly ClobRpcEndpoint[];
  wsRpcUrl?: string;
  factoryAddress?: Address;
  lensAddress?: Address;
  tokenFactoryAddress?: Address;
  faucetAddress?: Address;
  faucetTokens: readonly FaucetTokenConfig[];
  defaultPoolId?: `0x${string}`;
  deploymentBlock: bigint;
};

export type FaucetTokenConfig = {
  address: Address;
  symbol: string;
  decimals: number;
};

function optionalFaucetToken(address: string | undefined, symbol: string): FaucetTokenConfig[] {
  const parsed = optionalAddress(address);
  return parsed ? [{ address: parsed, symbol, decimals: 6 }] : [];
}

export const clobNetworksByChainId: Readonly<Record<number, ClobNetworkConfig>> = {
  [MONAD_TESTNET_CHAIN_ID]: {
    chain: monadTestnetChain,
    indexerGraphqlUrl:
      process.env.NEXT_PUBLIC_MONAD_ENVIO_GRAPHQL_URL ||
      process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL ||
      "http://localhost:8080/v1/graphql",
    rpcUrl: monadTestnetRpcUrl,
    rpcEndpoints: monadTestnetRpcEndpoints,
    wsRpcUrl: monadTestnetWsRpcUrl,
    factoryAddress: optionalAddress(
      process.env.NEXT_PUBLIC_MONAD_SPOT_CLOB_FACTORY_ADDRESS || "0xAE2D3bC901acc1B1f6fc4A7B60e16058bd9e178C",
    ),
    lensAddress: optionalAddress(
      process.env.NEXT_PUBLIC_MONAD_SPOT_CLOB_LENS_ADDRESS || "0xd82FC5946b63cFcDdB4706CFfe7DF248238779AA",
    ),
    tokenFactoryAddress: optionalAddress(
      process.env.NEXT_PUBLIC_MONAD_ERC20_TOKEN_FACTORY_ADDRESS || "0x898fcCf695D6f3a23B8Ef9F4d7C3EAf97ba837Cc",
    ),
    faucetAddress: optionalAddress(
      process.env.NEXT_PUBLIC_MONAD_TOKEN_FAUCET_ADDRESS || "0xB8d1b7f2a722A0b5315eaF0840F652A95a758598",
    ),
    faucetTokens: [
      ...optionalFaucetToken(
        process.env.NEXT_PUBLIC_MONAD_FAUCET_USDC_ADDRESS || "0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3",
        "USDC",
      ),
      ...optionalFaucetToken(
        process.env.NEXT_PUBLIC_MONAD_FAUCET_USDT_ADDRESS || "0xef271f6433E05757A94e28873911Af92f0D0b9f3",
        "USDT",
      ),
    ],
    defaultPoolId: optionalBytes32(
      process.env.NEXT_PUBLIC_MONAD_DEFAULT_POOL_ID ||
        "0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c",
    ),
    deploymentBlock: BigInt(process.env.NEXT_PUBLIC_MONAD_CLOB_DEPLOYMENT_BLOCK || "63351130"),
  },
  [ANVIL_CHAIN_ID]: {
    chain: anvilChain,
    indexerGraphqlUrl:
      process.env.NEXT_PUBLIC_ANVIL_ENVIO_GRAPHQL_URL ||
      process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL ||
      "http://localhost:8080/v1/graphql",
    rpcUrl: anvilRpcUrl,
    rpcEndpoints: anvilRpcEndpoints,
    factoryAddress: optionalAddress(
      process.env.NEXT_PUBLIC_SPOT_CLOB_FACTORY_ADDRESS ?? process.env.NEXT_PUBLIC_POOL_REGISTRY_ADDRESS,
    ),
    lensAddress: optionalAddress(process.env.NEXT_PUBLIC_SPOT_CLOB_LENS_ADDRESS),
    tokenFactoryAddress: optionalAddress(process.env.NEXT_PUBLIC_ERC20_TOKEN_FACTORY_ADDRESS),
    faucetAddress: optionalAddress(process.env.NEXT_PUBLIC_TOKEN_FAUCET_ADDRESS),
    faucetTokens: [
      ...optionalFaucetToken(process.env.NEXT_PUBLIC_FAUCET_USDC_ADDRESS, "USDC"),
      ...optionalFaucetToken(process.env.NEXT_PUBLIC_FAUCET_USDT_ADDRESS, "USDT"),
    ],
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
