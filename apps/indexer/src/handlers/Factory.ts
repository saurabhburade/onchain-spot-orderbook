import { indexer } from "envio";

const transactionFields = {
  transaction: ["hash", "from"],
  block: ["timestamp"],
} as const;

indexer.contractRegister(
  {
    contract: "SpotCLOBFactory",
    event: "PairCreated",
  },
  async ({ event, context }) => {
    context.chain.SpotCLOB.add(event.params.book);
  },
);

indexer.contractRegister(
  {
    contract: "SpotCLOBFactory",
    event: "PairCreatedLegacy",
  },
  async ({ event, context }) => {
    context.chain.SpotCLOB.add(event.params.book);
  },
);

indexer.onEvent(
  {
    contract: "SpotCLOBFactory",
    event: "PairCreated",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const existing = await context.Market.get(event.params.pairId);

    context.Market.set({
      id: event.params.pairId,
      book: event.params.book,
      baseAsset: event.params.baseAsset,
      quoteAsset: event.params.quoteAsset,
      lotSize: event.params.lotSize,
      tickSize: event.params.tickSize,
      minTick: event.params.minTick,
      maxTick: event.params.maxTick,
      tradingFeeBps: Number(event.params.tradingFeeBps),
      baseDecimals: existing?.baseDecimals ?? 0,
      quoteDecimals: existing?.quoteDecimals ?? 0,
      agnosticPricing: existing?.agnosticPricing ?? false,
      bestBid: existing?.bestBid ?? 0n,
      bestAsk: existing?.bestAsk ?? 0n,
      lastPrice: existing?.lastPrice ?? 0n,
      lastTradeAt: existing?.lastTradeAt ?? 0,
      sequence: existing?.sequence ?? 0n,
      orderCount: existing?.orderCount ?? 0n,
      openOrderCount: existing?.openOrderCount ?? 0n,
      tradeCount: existing?.tradeCount ?? 0n,
      baseVolume: existing?.baseVolume ?? 0n,
      quoteVolume: existing?.quoteVolume ?? 0n,
      quoteFees: existing?.quoteFees ?? 0n,
      creator: event.transaction.from,
      createdAt: event.block.timestamp,
      createdBlock: event.block.number,
      createdTxHash: event.transaction.hash,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });
  },
);

indexer.onEvent(
  {
    contract: "SpotCLOBFactory",
    event: "PairCreatedLegacy",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const existing = await context.Market.get(event.params.pairId);

    context.Market.set({
      id: event.params.pairId,
      book: event.params.book,
      baseAsset: event.params.baseAsset,
      quoteAsset: event.params.quoteAsset,
      lotSize: event.params.lotSize,
      tickSize: event.params.tickSize,
      minTick: event.params.minTick,
      maxTick: event.params.maxTick,
      tradingFeeBps: existing?.tradingFeeBps ?? 0,
      baseDecimals: existing?.baseDecimals ?? 0,
      quoteDecimals: existing?.quoteDecimals ?? 0,
      agnosticPricing: existing?.agnosticPricing ?? false,
      bestBid: existing?.bestBid ?? 0n,
      bestAsk: existing?.bestAsk ?? 0n,
      lastPrice: existing?.lastPrice ?? 0n,
      lastTradeAt: existing?.lastTradeAt ?? 0,
      sequence: existing?.sequence ?? 0n,
      orderCount: existing?.orderCount ?? 0n,
      openOrderCount: existing?.openOrderCount ?? 0n,
      tradeCount: existing?.tradeCount ?? 0n,
      baseVolume: existing?.baseVolume ?? 0n,
      quoteVolume: existing?.quoteVolume ?? 0n,
      quoteFees: existing?.quoteFees ?? 0n,
      creator: event.transaction.from,
      createdAt: event.block.timestamp,
      createdBlock: event.block.number,
      createdTxHash: event.transaction.hash,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });
  },
);

indexer.onEvent(
  {
    contract: "SpotCLOBFactory",
    event: "AgnosticPricingConfigured",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const market = await context.Market.getOrThrow(event.params.pairId);
    context.Market.set({
      ...market,
      baseDecimals: Number(event.params.baseDecimals),
      quoteDecimals: Number(event.params.quoteDecimals),
      agnosticPricing: true,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });
  },
);

indexer.onEvent(
  {
    contract: "SpotCLOBFactory",
    event: "PairTradingFeeUpdated",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const market = await context.Market.getOrThrow(event.params.pairId);
    context.Market.set({
      ...market,
      tradingFeeBps: Number(event.params.newFeeBps),
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });
  },
);
