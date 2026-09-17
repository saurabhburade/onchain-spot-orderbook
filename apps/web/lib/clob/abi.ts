import type { Abi } from "viem";

export const clobAbi = [
  {
    type: "error",
    name: "NoLiquidity",
    inputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [
      { name: "free", type: "uint256" },
      { name: "locked", type: "uint256" },
      { name: "total", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getOrderBook",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "depth", type: "uint16" },
    ],
    outputs: [
      {
        name: "bids",
        type: "tuple[]",
        components: [
          { name: "price", type: "uint128" },
          { name: "quantity", type: "uint128" },
        ],
      },
      {
        name: "asks",
        type: "tuple[]",
        components: [
          { name: "price", type: "uint128" },
          { name: "quantity", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getBestPrices",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "bidExists", type: "bool" },
      { name: "bidPrice", type: "uint128" },
      { name: "bidQuantity", type: "uint128" },
      { name: "askExists", type: "bool" },
      { name: "askPrice", type: "uint128" },
      { name: "askQuantity", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "externalOrderId", type: "bytes32" }],
    outputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "side", type: "uint8" },
          { name: "price", type: "uint128" },
          { name: "quantity", type: "uint128" },
          { name: "expiry", type: "uint64" },
          { name: "clientOrderId", type: "uint64" },
        ],
      },
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "quantity", type: "uint128" },
          { name: "filledQuantity", type: "uint128" },
          { name: "createdAt", type: "uint64" },
          { name: "status", type: "uint8" },
          { name: "kind", type: "uint8" },
          { name: "filledQuoteQuantity", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getUserOrderIds",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "trader", type: "address" },
      { name: "cursor", type: "bytes32" },
      { name: "limit", type: "uint16" },
      { name: "statusFlags", type: "uint8" },
    ],
    outputs: [
      { name: "orderIds", type: "bytes32[]" },
      { name: "nextCursor", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "getOrderLinks",
    stateMutability: "view",
    inputs: [{ name: "externalOrderId", type: "bytes32" }],
    outputs: [
      { name: "previousOrderId", type: "bytes32" },
      { name: "nextOrderId", type: "bytes32" },
      { name: "resting", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "placeLimitOrderWithMaxBookSteps",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "side", type: "uint8" },
          { name: "price", type: "uint128" },
          { name: "quantity", type: "uint128" },
          { name: "expiry", type: "uint64" },
          { name: "clientOrderId", type: "uint64" },
        ],
      },
      { name: "maxBookSteps", type: "uint32" },
    ],
    outputs: [{ name: "orderId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "executeMarketOrder",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "side", type: "uint8" },
          { name: "quantity", type: "uint128" },
          { name: "priceLimit", type: "uint128" },
          { name: "minFillQuantity", type: "uint128" },
          { name: "clientOrderId", type: "uint64" },
        ],
      },
      { name: "maxBookSteps", type: "uint32" },
    ],
    outputs: [
      { name: "orderId", type: "bytes32" },
      { name: "filledQuantity", type: "uint128" },
      { name: "quoteQuantity", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "externalOrderId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "BookUpdated",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "bestBid", type: "uint128", indexed: false },
      { name: "bestAsk", type: "uint128", indexed: false },
      { name: "sequence", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TradeExecuted",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "takerOrderId", type: "bytes32", indexed: true },
      { name: "makerOrderId", type: "bytes32", indexed: true },
      { name: "baseAsset", type: "address", indexed: false },
      { name: "quoteAsset", type: "address", indexed: false },
      { name: "price", type: "uint128", indexed: false },
      { name: "quantity", type: "uint128", indexed: false },
      { name: "quoteQuantity", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderPlaced",
    inputs: [
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "baseAsset", type: "address", indexed: false },
      { name: "quoteAsset", type: "address", indexed: false },
      { name: "side", type: "uint8", indexed: false },
      { name: "price", type: "uint128", indexed: false },
      { name: "quantity", type: "uint128", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
      { name: "clientOrderId", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderFilled",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "fillQuantity", type: "uint128", indexed: false },
      { name: "totalFilledQuantity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderPartiallyFilled",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "fillQuantity", type: "uint128", indexed: false },
      { name: "remainingQuantity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderCancelled",
    inputs: [
      { name: "orderId", type: "bytes32", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "remainingQuantity", type: "uint128", indexed: false },
    ],
  },
] as const satisfies Abi;

export const clobLensAbi = [
  {
    type: "function",
    name: "getUserOrders",
    stateMutability: "view",
    inputs: [
      { name: "book", type: "address" },
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
      { name: "cursor", type: "bytes32" },
      { name: "limit", type: "uint16" },
      { name: "statusFlags", type: "uint8" },
    ],
    outputs: [
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "orderId", type: "bytes32" },
          {
            name: "order",
            type: "tuple",
            components: [
              { name: "trader", type: "address" },
              { name: "baseAsset", type: "address" },
              { name: "quoteAsset", type: "address" },
              { name: "side", type: "uint8" },
              { name: "price", type: "uint128" },
              { name: "quantity", type: "uint128" },
              { name: "expiry", type: "uint64" },
              { name: "clientOrderId", type: "uint64" },
            ],
          },
          {
            name: "state",
            type: "tuple",
            components: [
              { name: "quantity", type: "uint128" },
              { name: "filledQuantity", type: "uint128" },
              { name: "createdAt", type: "uint64" },
              { name: "status", type: "uint8" },
              { name: "kind", type: "uint8" },
              { name: "filledQuoteQuantity", type: "uint256" },
            ],
          },
        ],
      },
      { name: "nextCursor", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "getMarketSnapshot",
    stateMutability: "view",
    inputs: [
      { name: "book", type: "address" },
      { name: "baseAsset", type: "address" },
      { name: "quoteAsset", type: "address" },
      { name: "depth", type: "uint16" },
    ],
    outputs: [
      {
        name: "snapshot",
        type: "tuple",
        components: [
          {
            name: "market",
            type: "tuple",
            components: [
              { name: "baseAsset", type: "address" },
              { name: "quoteAsset", type: "address" },
              { name: "lotSize", type: "uint128" },
              { name: "tickSize", type: "uint128" },
              { name: "minTick", type: "uint24" },
              { name: "maxTick", type: "uint24" },
              { name: "tradingFeeBps", type: "uint16" },
              { name: "baseDecimals", type: "uint8" },
              { name: "quoteDecimals", type: "uint8" },
              { name: "agnosticPricing", type: "bool" },
              { name: "enabled", type: "bool" },
            ],
          },
          { name: "sequence", type: "uint64" },
          { name: "bidExists", type: "bool" },
          { name: "bidPrice", type: "uint128" },
          { name: "bidQuantity", type: "uint128" },
          { name: "askExists", type: "bool" },
          { name: "askPrice", type: "uint128" },
          { name: "askQuantity", type: "uint128" },
          {
            name: "bids",
            type: "tuple[]",
            components: [
              { name: "price", type: "uint128" },
              { name: "quantity", type: "uint128" },
            ],
          },
          {
            name: "asks",
            type: "tuple[]",
            components: [
              { name: "price", type: "uint128" },
              { name: "quantity", type: "uint128" },
            ],
          },
        ],
      },
    ],
  },
] as const satisfies Abi;

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

export const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;
