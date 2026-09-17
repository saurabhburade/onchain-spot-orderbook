import { type Abi, type Address, decodeFunctionResult, type Hex } from "viem";

const currentPoolRegistryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "pool",
        type: "tuple",
        components: [
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "book", type: "address" },
          { name: "lotSize", type: "uint128" },
          { name: "tickSize", type: "uint128" },
          { name: "minTick", type: "uint24" },
          { name: "maxTick", type: "uint24" },
          { name: "tradingFeeBps", type: "uint16" },
          { name: "baseDecimals", type: "uint8" },
          { name: "quoteDecimals", type: "uint8" },
          { name: "agnosticPricing", type: "bool" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const satisfies Abi;

const legacyPoolRegistryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "pool",
        type: "tuple",
        components: [
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "book", type: "address" },
          { name: "lotSize", type: "uint128" },
          { name: "tickSize", type: "uint128" },
          { name: "minTick", type: "uint24" },
          { name: "maxTick", type: "uint24" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const satisfies Abi;

export type RawPool = {
  baseAsset: Address;
  quoteAsset: Address;
  book: Address;
  lotSize: bigint;
  tickSize: bigint;
  minTick: bigint;
  maxTick: bigint;
  tradingFeeBps: number;
  baseDecimals: number;
  quoteDecimals: number;
  agnosticPricing: boolean;
  legacyFactory: boolean;
  exists: boolean;
};

type DecodedPool = Omit<RawPool, "minTick" | "maxTick" | "legacyFactory"> & {
  minTick: number | bigint;
  maxTick: number | bigint;
  legacyFactory?: boolean;
};

export function normalizeRawPool(value: unknown): RawPool {
  const tuple = value as
    | DecodedPool
    | readonly [
        Address,
        Address,
        Address,
        bigint,
        bigint,
        number | bigint,
        number | bigint,
        number,
        number,
        number,
        boolean,
        boolean,
      ];
  const pool: DecodedPool =
    "baseAsset" in tuple
      ? tuple
      : {
          baseAsset: tuple[0],
          quoteAsset: tuple[1],
          book: tuple[2],
          lotSize: tuple[3],
          tickSize: tuple[4],
          minTick: tuple[5],
          maxTick: tuple[6],
          tradingFeeBps: tuple[7],
          baseDecimals: tuple[8],
          quoteDecimals: tuple[9],
          agnosticPricing: tuple[10],
          exists: tuple[11],
        };

  // Viem decodes Solidity integers up to 48 bits as JavaScript numbers.
  // Normalize tick indexes so price arithmetic stays entirely in bigint.
  return {
    ...pool,
    minTick: BigInt(pool.minTick),
    maxTick: BigInt(pool.maxTick),
    legacyFactory: pool.legacyFactory ?? false,
  };
}

export function decodePoolResultData(data: Hex): RawPool {
  try {
    return normalizeRawPool(decodeFunctionResult({ abi: currentPoolRegistryAbi, functionName: "getPool", data }));
  } catch (currentDecodeError) {
    try {
      const pool = decodeFunctionResult({
        abi: legacyPoolRegistryAbi,
        functionName: "getPool",
        data,
      });
      return {
        baseAsset: pool.baseAsset,
        quoteAsset: pool.quoteAsset,
        book: pool.book,
        lotSize: pool.lotSize,
        tickSize: pool.tickSize,
        minTick: BigInt(pool.minTick),
        maxTick: BigInt(pool.maxTick),
        tradingFeeBps: 0,
        baseDecimals: 0,
        quoteDecimals: 0,
        agnosticPricing: false,
        legacyFactory: true,
        exists: pool.exists,
      };
    } catch {
      throw currentDecodeError;
    }
  }
}
