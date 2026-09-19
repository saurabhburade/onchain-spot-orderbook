import type { Abi } from "viem";

export const poolRegistryAbi = [
  {
    type: "function",
    name: "marketCreationFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isQuoteToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "pairId",
    stateMutability: "pure",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "pairLotDecimals",
    stateMutability: "view",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "pairLotSize",
    stateMutability: "view",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "createPair",
    stateMutability: "payable",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
    ],
    outputs: [
      { name: "id", type: "bytes32" },
      { name: "book", type: "address" },
    ],
  },
  {
    type: "function",
    name: "createPair",
    stateMutability: "payable",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
      { name: "tickSize", type: "uint128" },
      { name: "minTick", type: "uint24" },
      { name: "maxTick", type: "uint24" },
    ],
    outputs: [
      { name: "id", type: "bytes32" },
      { name: "book", type: "address" },
    ],
  },
  {
    type: "function",
    name: "createPair",
    stateMutability: "payable",
    inputs: [
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
      { name: "lotSize", type: "uint128" },
      { name: "tickSize", type: "uint128" },
      { name: "minTick", type: "uint24" },
      { name: "maxTick", type: "uint24" },
    ],
    outputs: [
      { name: "id", type: "bytes32" },
      { name: "book", type: "address" },
    ],
  },
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
  {
    type: "function",
    name: "allPairsLength",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pairAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "PairCreated",
    inputs: [
      { name: "pairId", type: "bytes32", indexed: true },
      { name: "baseAsset", type: "address", indexed: true },
      { name: "quoteAsset", type: "address", indexed: true },
      { name: "book", type: "address", indexed: false },
      { name: "lotSize", type: "uint128", indexed: false },
      { name: "tickSize", type: "uint128", indexed: false },
      { name: "minTick", type: "uint24", indexed: false },
      { name: "maxTick", type: "uint24", indexed: false },
      { name: "tradingFeeBps", type: "uint16", indexed: false },
    ],
  },
] as const satisfies Abi;
