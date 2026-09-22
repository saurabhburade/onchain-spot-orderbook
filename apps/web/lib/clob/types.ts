import type { Address, Hash } from "viem";

export type PoolId = `0x${string}`;
export type OrderSide = "buy" | "sell";
export type AssetKey = "base" | "quote" | Address;

export type PoolMetadata = {
  poolId: PoolId;
  clobAddress: Address;
  baseAsset: Address;
  quoteAsset: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  lotSize: bigint;
  tickSize: bigint;
  minTick: bigint;
  maxTick: bigint;
  tradingFeeBps: number;
  agnosticPricing: boolean;
  legacyFactory?: boolean;
};

export type MarketListing = PoolMetadata & {
  bestBid: string | null;
  bestAsk: string | null;
  lastPrice?: string | null;
  change24h?: number | null;
  volume24h?: string | null;
  baseIconUrl?: string;
  quoteIconUrl?: string;
};

export type MarketToken = {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
};

export type CreateMarketInput = {
  baseAsset: Address;
  quoteAsset: Address;
};

export type CreatedMarket = {
  poolId: PoolId;
  book: Address;
  hash: Hash;
};

export type PriceLevel = {
  priceRaw: bigint;
  quantityLots: bigint;
  price: string;
  quantity: string;
  quoteValue: string;
};

export type OrderBook = { bids: PriceLevel[]; asks: PriceLevel[] };

export type BestPrices = {
  bid: PriceLevel | null;
  ask: PriceLevel | null;
};

export type TradeExecuted = {
  poolId: PoolId;
  takerOrderId: PoolId;
  makerOrderId: PoolId;
  baseAsset: Address;
  quoteAsset: Address;
  priceRaw: bigint;
  quantityLots: bigint;
  quoteQuantityRaw: bigint;
  price: string;
  quantity: string;
  quoteQuantity: string;
  timestamp: bigint;
  blockNumber: bigint | null;
  transactionHash: Hash;
  logIndex: number;
};

export type TokenBalance = {
  asset: Address;
  symbol: string;
  decimals: number;
  freeRaw: bigint;
  lockedRaw: bigint;
  totalRaw: bigint;
  walletRaw: bigint;
  free: string;
  locked: string;
  total: string;
  wallet: string;
};

export type OpenOrder = {
  orderId: PoolId;
  side: OrderSide;
  kind: "limit" | "market";
  priceRaw: bigint;
  quantityLots: bigint;
  filledQuantityLots: bigint;
  filledQuoteQuantity: bigint;
  price: string;
  quantity: string;
  filled: string;
  remaining: string;
  status: "open" | "partially-filled" | "filled" | "cancelled";
  createdAt: bigint;
  expiry: bigint;
  clientOrderId: bigint;
  transactionHash?: Hash;
};

export type AsyncState = {
  loading: boolean;
  error: Error | null;
};

export type TransactionMetrics = {
  /** One-time Privy root authorization for a fresh browser session key. */
  setupMs?: number;
  /** UserOperation preparation, local for session keys and API-backed for root signing. */
  prepareMs?: number;
  /** Measured server and transport components inside the prepare request. */
  prepareBreakdown?: {
    /** Browser/API transport plus framework overhead before response headers. */
    networkMs: number;
    /** Reading and decoding the response body after headers arrive. */
    responseMs: number;
    authMs: number;
    serverMs: number;
    /** Wall time for parallel chain reads; individual reads overlap. */
    rpcWallMs: number;
    chainIdMs: number;
    delegationMs: number;
    orderBookMs: number;
    policyRpcMs: number;
    nonceMs: number;
    /** Local call validation, encoding, and UserOperation hashing. */
    localMs: number;
  };
  signMs: number;
  submitMs: number;
  submitBreakdown?: {
    networkMs: number;
    responseMs: number;
    authMs: number;
    serverMs: number;
    /** Wall time for validation reads and simulation, which run concurrently. */
    validationWallMs: number;
    chainIdMs: number;
    delegationMs: number;
    orderBookMs: number;
    policyRpcMs: number;
    nonceMs: number;
    hashMs: number;
    simulationMs: number;
    broadcastMs: number;
    broadcastPrepareMs: number;
    sponsorNonceMs: number;
    gasPriceMs: number;
    sponsorSignMs: number;
    rpcSubmissionMs: number;
  };
  totalMs: number;
};

export type TransactionState = AsyncState & {
  status: "idle" | "pending" | "submitted" | "success" | "error";
  hash?: Hash;
  metrics?: TransactionMetrics;
  transactionId?: string;
};

export type LimitOrderInput = {
  side: OrderSide;
  price: string;
  quantity: string;
  expiry?: bigint;
  clientOrderId?: bigint;
  maxBookSteps?: bigint;
};

export type MarketOrderInput = {
  side: OrderSide;
  quantity: string;
  priceLimit?: string;
  minFillQuantity?: string;
  clientOrderId?: bigint;
  maxBookSteps?: bigint;
};

/** Development-only token/native funding on a local Anvil node. */
export type AnvilFaucetInput = {
  nativeAmount?: string;
  baseAmount?: string;
  quoteAmount?: string;
};
