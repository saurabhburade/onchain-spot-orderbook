export type Address = `0x${string}`;

export type ContractTokenConfig = {
  address: Address;
  symbol: string;
  decimals: number;
};

export type FaucetTokenConfig = ContractTokenConfig;

export type ClobContractConfig = {
  factoryAddress?: Address;
  lensAddress?: Address;
  tokenFactoryAddress?: Address;
  faucetAddress?: Address;
  tokens: readonly ContractTokenConfig[];
  faucetTokens: readonly FaucetTokenConfig[];
};

const monadToken = {
  address: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
  symbol: "MON",
  decimals: 18,
} as const satisfies ContractTokenConfig;
const monadUsdc = {
  address: "0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3",
  symbol: "USDC",
  decimals: 6,
} as const satisfies ContractTokenConfig;
const monadUsdt = {
  address: "0xef271f6433E05757A94e28873911Af92f0D0b9f3",
  symbol: "USDT",
  decimals: 6,
} as const satisfies ContractTokenConfig;
const anvilMon = {
  address: "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0",
  symbol: "MON",
  decimals: 18,
} as const satisfies ContractTokenConfig;
const anvilUsdc = {
  address: "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82",
  symbol: "USDC",
  decimals: 6,
} as const satisfies ContractTokenConfig;

export const clobContractsByChainId = {
  10143: {
    factoryAddress: "0x50fcEa11c0F01F0eeAa5E980dc4ae9977559330b",
    lensAddress: "0xDD090DDa847b9BB8f71e4de2Bc3AA74efA528e0F",
    tokenFactoryAddress: "0x898fcCf695D6f3a23B8Ef9F4d7C3EAf97ba837Cc",
    faucetAddress: "0xB8d1b7f2a722A0b5315eaF0840F652A95a758598",
    tokens: [monadToken, monadUsdc, monadUsdt],
    faucetTokens: [monadUsdc, monadUsdt],
  },
  31337: {
    factoryAddress: "0x9A676e781A523b5d0C0e43731313A708CB607508",
    tokens: [anvilMon, anvilUsdc],
    faucetTokens: [],
  },
} as const satisfies Readonly<Record<number, ClobContractConfig>>;
