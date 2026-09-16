import { indexer } from "envio";
import { CANDLE_INTERVALS_SECONDS, candleEntityId, candleStart } from "../candles.js";
import { bookUpdateEntityId, eventEntityId, orderEntityId, orderSide } from "../ids.js";
import { recordMarketStats } from "../market-stats.js";

const transactionFields = {
  transaction: ["hash", "from"],
  block: ["timestamp"],
} as const;

indexer.onEvent(
  {
    contract: "SpotCLOB",
    event: "MarketActivated",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const existing = await context.Market.get(event.params.marketId);
    if (existing) return;

    context.Market.set({
      id: event.params.marketId,
      book: event.srcAddress,
      baseAsset: event.params.baseAsset,
      quoteAsset: event.params.quoteAsset,
      lotSize: event.params.lotSize,
      tickSize: event.params.tickSize,
      minTick: event.params.minTick,
      maxTick: event.params.maxTick,
      tradingFeeBps: Number(event.params.tradingFeeBps),
      baseDecimals: 0,
      quoteDecimals: 0,
      agnosticPricing: false,
      bestBid: 0n,
      bestAsk: 0n,
      lastPrice: 0n,
      lastTradeAt: 0,
      sequence: 0n,
      orderCount: 0n,
      openOrderCount: 0n,
      tradeCount: 0n,
      baseVolume: 0n,
      quoteVolume: 0n,
      quoteFees: 0n,
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
    contract: "SpotCLOB",
    event: "MarketActivatedLegacy",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const existing = await context.Market.get(event.params.marketId);
    if (existing) return;

    context.Market.set({
      id: event.params.marketId,
      book: event.srcAddress,
      baseAsset: event.params.baseAsset,
      quoteAsset: event.params.quoteAsset,
      lotSize: event.params.lotSize,
      tickSize: event.params.tickSize,
      minTick: event.params.minTick,
      maxTick: event.params.maxTick,
      tradingFeeBps: 0,
      baseDecimals: 0,
      quoteDecimals: 0,
      agnosticPricing: false,
      bestBid: 0n,
      bestAsk: 0n,
      lastPrice: 0n,
      lastTradeAt: 0,
      sequence: 0n,
      orderCount: 0n,
      openOrderCount: 0n,
      tradeCount: 0n,
      baseVolume: 0n,
      quoteVolume: 0n,
      quoteFees: 0n,
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
  { contract: "SpotCLOB", event: "OrderPlaced", fields: transactionFields },
  async ({ event, context }) => {
    const market = await context.Market.getOrThrow(event.params.poolId);
    const id = orderEntityId(event.srcAddress, event.params.orderId);
    const nextOpenOrderCount = market.openOrderCount + 1n;

    context.Order.set({
      id,
      orderId: event.params.orderId,
      marketId: event.params.poolId,
      book: event.srcAddress,
      trader: event.params.trader,
      baseAsset: event.params.baseAsset,
      quoteAsset: event.params.quoteAsset,
      side: orderSide(event.params.side),
      kind: "LIMIT",
      status: "OPEN",
      isOpen: true,
      price: event.params.price,
      quantity: event.params.quantity,
      filledQuantity: 0n,
      remainingQuantity: event.params.quantity,
      quoteQuantity: 0n,
      expiry: event.params.expiry,
      clientOrderId: event.params.clientOrderId,
      createdAt: event.block.timestamp,
      createdBlock: event.block.number,
      createdTxHash: event.transaction.hash,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });

    context.Market.set({
      ...market,
      orderCount: market.orderCount + 1n,
      openOrderCount: nextOpenOrderCount,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: nextOpenOrderCount,
      delta: { orderPlacedCount: 1n, limitOrderCount: 1n },
    });
  },
);

indexer.onEvent(
  { contract: "SpotCLOB", event: "TradeExecuted", fields: transactionFields },
  async ({ event, context }) => {
    const market = await context.Market.getOrThrow(event.params.poolId);
    const rawBaseQuantity = market.agnosticPricing ? event.params.quantity : event.params.quantity * market.lotSize;
    const makerId = orderEntityId(event.srcAddress, event.params.makerOrderId);
    const takerId = orderEntityId(event.srcAddress, event.params.takerOrderId);
    const [maker, taker] = await Promise.all([context.Order.getOrThrow(makerId), context.Order.getOrThrow(takerId)]);

    context.Trade.set({
      id: eventEntityId(event.transaction.hash, event.logIndex),
      marketId: event.params.poolId,
      book: event.srcAddress,
      makerOrderId: makerId,
      takerOrderId: takerId,
      baseAsset: event.params.baseAsset,
      quoteAsset: event.params.quoteAsset,
      price: event.params.price,
      quantity: event.params.quantity,
      quoteQuantity: event.params.quoteQuantity,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
    });

    context.Order.set({
      ...maker,
      quoteQuantity: maker.quoteQuantity + event.params.quoteQuantity,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });
    context.Order.set({
      ...taker,
      quoteQuantity: taker.quoteQuantity + event.params.quoteQuantity,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });

    const candles = await Promise.all(
      CANDLE_INTERVALS_SECONDS.map(async (intervalSeconds) => {
        const startTimestamp = candleStart(event.block.timestamp, intervalSeconds);
        const id = candleEntityId(event.params.poolId, intervalSeconds, startTimestamp);
        return {
          existing: await context.MarketCandle.get(id),
          id,
          intervalSeconds,
          startTimestamp,
        };
      }),
    );

    for (const { existing, id, intervalSeconds, startTimestamp } of candles) {
      context.MarketCandle.set(
        existing
          ? {
              ...existing,
              high: event.params.price > existing.high ? event.params.price : existing.high,
              low: event.params.price < existing.low ? event.params.price : existing.low,
              close: event.params.price,
              lotVolume: existing.lotVolume + event.params.quantity,
              baseVolume: existing.baseVolume + rawBaseQuantity,
              quoteVolume: existing.quoteVolume + event.params.quoteQuantity,
              tradeCount: existing.tradeCount + 1,
              lastBlock: event.block.number,
              lastLogIndex: event.logIndex,
              lastTxHash: event.transaction.hash,
            }
          : {
              id,
              marketId: event.params.poolId,
              intervalSeconds,
              startTimestamp,
              endTimestamp: startTimestamp + intervalSeconds,
              open: event.params.price,
              high: event.params.price,
              low: event.params.price,
              close: event.params.price,
              lotVolume: event.params.quantity,
              baseVolume: rawBaseQuantity,
              quoteVolume: event.params.quoteQuantity,
              tradeCount: 1,
              firstBlock: event.block.number,
              lastBlock: event.block.number,
              firstLogIndex: event.logIndex,
              lastLogIndex: event.logIndex,
              firstTxHash: event.transaction.hash,
              lastTxHash: event.transaction.hash,
            },
      );
    }

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: market.openOrderCount,
      delta: {
        tradeCount: 1n,
        lotVolume: event.params.quantity,
        baseVolume: rawBaseQuantity,
        quoteVolume: event.params.quoteQuantity,
      },
    });

    context.Market.set({
      ...market,
      lastPrice: event.params.price,
      lastTradeAt: event.block.timestamp,
      tradeCount: market.tradeCount + 1n,
      baseVolume: market.baseVolume + rawBaseQuantity,
      quoteVolume: market.quoteVolume + event.params.quoteQuantity,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });
  },
);

indexer.onEvent(
  { contract: "SpotCLOB", event: "TradingFeeCharged", fields: transactionFields },
  async ({ event, context }) => {
    const market = await context.Market.getOrThrow(event.params.poolId);

    context.Market.set({
      ...market,
      quoteFees: market.quoteFees + event.params.amount,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: market.openOrderCount,
      delta: { quoteFees: event.params.amount },
    });
  },
);

indexer.onEvent(
  { contract: "SpotCLOB", event: "OrderFilled", fields: transactionFields },
  async ({ event, context }) => {
    const [market, order] = await Promise.all([
      context.Market.getOrThrow(event.params.poolId),
      context.Order.getOrThrow(orderEntityId(event.srcAddress, event.params.orderId)),
    ]);
    const nextOpenOrderCount = order.isOpen ? market.openOrderCount - 1n : market.openOrderCount;

    context.Order.set({
      ...order,
      status: "FILLED",
      isOpen: false,
      filledQuantity: event.params.totalFilledQuantity,
      remainingQuantity: 0n,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });

    context.Market.set({
      ...market,
      openOrderCount: nextOpenOrderCount,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: nextOpenOrderCount,
      delta: { filledOrderCount: 1n },
    });
  },
);

indexer.onEvent(
  {
    contract: "SpotCLOB",
    event: "OrderPartiallyFilled",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const [market, order] = await Promise.all([
      context.Market.getOrThrow(event.params.poolId),
      context.Order.getOrThrow(orderEntityId(event.srcAddress, event.params.orderId)),
    ]);

    context.Order.set({
      ...order,
      status: "PARTIALLY_FILLED",
      filledQuantity: order.quantity - event.params.remainingQuantity,
      remainingQuantity: event.params.remainingQuantity,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: market.openOrderCount,
      delta: { partialFillEventCount: 1n },
    });
  },
);

indexer.onEvent(
  {
    contract: "SpotCLOB",
    event: "MarketOrderExecuted",
    fields: transactionFields,
  },
  async ({ event, context }) => {
    const [market, order] = await Promise.all([
      context.Market.getOrThrow(event.params.poolId),
      context.Order.getOrThrow(orderEntityId(event.srcAddress, event.params.orderId)),
    ]);
    const nextOpenOrderCount = order.isOpen ? market.openOrderCount - 1n : market.openOrderCount;

    context.Order.set({
      ...order,
      kind: "MARKET",
      status: event.params.filledQuantity === event.params.requestedQuantity ? "FILLED" : "PARTIALLY_FILLED",
      isOpen: false,
      filledQuantity: event.params.filledQuantity,
      remainingQuantity: event.params.requestedQuantity - event.params.filledQuantity,
      quoteQuantity: event.params.quoteQuantity,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });

    context.Market.set({
      ...market,
      openOrderCount: nextOpenOrderCount,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: nextOpenOrderCount,
      delta: { limitOrderCount: -1n, marketOrderCount: 1n },
    });
  },
);

indexer.onEvent(
  { contract: "SpotCLOB", event: "OrderCancelled", fields: transactionFields },
  async ({ event, context }) => {
    const [market, order] = await Promise.all([
      context.Market.getOrThrow(event.params.poolId),
      context.Order.getOrThrow(orderEntityId(event.srcAddress, event.params.orderId)),
    ]);
    const nextOpenOrderCount = order.isOpen ? market.openOrderCount - 1n : market.openOrderCount;

    context.Order.set({
      ...order,
      status: "CANCELLED",
      isOpen: false,
      filledQuantity: order.quantity - event.params.remainingQuantity,
      remainingQuantity: event.params.remainingQuantity,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
      updatedTxHash: event.transaction.hash,
    });

    context.Market.set({
      ...market,
      openOrderCount: nextOpenOrderCount,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });

    await recordMarketStats({
      store: context.MarketIntervalStats,
      marketId: event.params.poolId,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
      openOrderCountBefore: market.openOrderCount,
      openOrderCountAfter: nextOpenOrderCount,
      delta: { cancelledOrderCount: 1n },
    });
  },
);

indexer.onEvent(
  { contract: "SpotCLOB", event: "BookUpdated", fields: transactionFields },
  async ({ event, context }) => {
    const market = await context.Market.getOrThrow(event.params.poolId);

    context.BookUpdate.set({
      id: bookUpdateEntityId(event.params.poolId, event.params.sequence),
      marketId: event.params.poolId,
      book: event.srcAddress,
      bestBid: event.params.bestBid,
      bestAsk: event.params.bestAsk,
      sequence: event.params.sequence,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      txHash: event.transaction.hash,
    });

    context.Market.set({
      ...market,
      bestBid: event.params.bestBid,
      bestAsk: event.params.bestAsk,
      sequence: event.params.sequence,
      updatedAt: event.block.timestamp,
      updatedBlock: event.block.number,
    });
  },
);
