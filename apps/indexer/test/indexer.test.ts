import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { candleEntityId, candleStart } from "../src/candles.js";
import { bookUpdateEntityId, orderEntityId } from "../src/ids.js";
import { marketIntervalStatsEntityId } from "../src/market-stats.js";

const FACTORY = "0x50fcea11c0f01f0eeaa5e980dc4ae9977559330b" as const;
const BOOK = "0xb521cd32e3e7be89f0055ec7691041862d515f71" as const;
const TRADER = "0x886540a55cfe78dc462c384a57e43ac275be74fa" as const;
const OTHER_TRADER = "0x2222222222222222222222222222222222222222" as const;
const BASE = "0x1111111111111111111111111111111111111111" as const;
const QUOTE = "0xa3bcafb554fe87109b92b3655c7cf36ba5c46af3" as const;
const POOL_ID = `0x${"11".repeat(32)}`;
const ORDER_ID = `0x${"00".repeat(31)}01`;
const OTHER_ORDER_ID = `0x${"00".repeat(31)}02`;
const TX_HASH = `0x${"aa".repeat(32)}`;
const OTHER_TX_HASH = `0x${"bb".repeat(32)}`;
const CANCEL_TX_HASH = `0x${"cc".repeat(32)}`;

describe("CLOB handlers", () => {
  it("retains compatibility with the legacy PairCreated event", async () => {
    const testIndexer = createTestIndexer();
    const [chainId] = testIndexer.chainIds;
    if (chainId === undefined) throw new Error("Expected one configured EVM chain");

    await testIndexer.process({
      chains: {
        [chainId]: {
          simulate: [
            {
              contract: "SpotCLOBFactory",
              event: "PairCreatedLegacy",
              srcAddress: FACTORY,
              logIndex: 0,
              block: { number: 63_617_141, timestamp: 1_789_583_718 },
              transaction: { hash: TX_HASH, from: TRADER },
              params: {
                pairId: POOL_ID,
                baseAsset: BASE,
                quoteAsset: QUOTE,
                book: BOOK,
                lotSize: 1_000_000_000_000_000_000n,
                tickSize: 1_000n,
                minTick: 1n,
                maxTick: 1_000_000n,
              },
            },
          ],
        },
      },
    });

    expect(testIndexer.chains[chainId].SpotCLOB.addresses).toContain(BOOK);
    expect(await testIndexer.Market.getOrThrow(POOL_ID)).toMatchObject({
      id: POOL_ID,
      book: BOOK,
      tradingFeeBps: 0,
      createdBlock: 63_617_141,
    });
  });

  it("discovers a book and materializes its market, order, and latest quote", async () => {
    const testIndexer = createTestIndexer();
    const [chainId] = testIndexer.chainIds;
    if (chainId === undefined) throw new Error("Expected one configured EVM chain");

    await testIndexer.process({
      chains: {
        [chainId]: {
          simulate: [
            {
              contract: "SpotCLOBFactory",
              event: "PairCreated",
              srcAddress: FACTORY,
              logIndex: 0,
              block: { number: 63_617_140, timestamp: 1_800_000_000 },
              transaction: { hash: TX_HASH, from: TRADER },
              params: {
                pairId: POOL_ID,
                baseAsset: BASE,
                quoteAsset: QUOTE,
                book: BOOK,
                lotSize: 1_000_000_000_000_000_000n,
                tickSize: 1_000n,
                minTick: 1n,
                maxTick: 1_000_000n,
                tradingFeeBps: 10n,
              },
            },
            {
              contract: "SpotCLOBFactory",
              event: "PairTradingFeeUpdated",
              srcAddress: FACTORY,
              logIndex: 1,
              block: { number: 63_617_141, timestamp: 1_800_000_001 },
              transaction: { hash: TX_HASH },
              params: {
                pairId: POOL_ID,
                previousFeeBps: 10n,
                newFeeBps: 25n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "OrderPlaced",
              srcAddress: BOOK,
              logIndex: 2,
              block: { number: 63_617_141, timestamp: 1_800_000_001 },
              transaction: { hash: TX_HASH },
              params: {
                orderId: ORDER_ID,
                trader: TRADER,
                poolId: POOL_ID,
                baseAsset: BASE,
                quoteAsset: QUOTE,
                side: 0n,
                price: 428_000n,
                quantity: 3n,
                expiry: 0n,
                clientOrderId: 42n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "BookUpdated",
              srcAddress: BOOK,
              logIndex: 3,
              block: { number: 63_617_141, timestamp: 1_800_000_001 },
              transaction: { hash: TX_HASH },
              params: {
                poolId: POOL_ID,
                bestBid: 428_000n,
                bestAsk: 429_000n,
                sequence: 1n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "OrderPlaced",
              srcAddress: BOOK,
              logIndex: 4,
              block: { number: 63_617_142, timestamp: 1_800_000_002 },
              transaction: { hash: OTHER_TX_HASH },
              params: {
                orderId: OTHER_ORDER_ID,
                trader: OTHER_TRADER,
                poolId: POOL_ID,
                baseAsset: BASE,
                quoteAsset: QUOTE,
                side: 1n,
                price: 428_000n,
                quantity: 2n,
                expiry: 0n,
                clientOrderId: 43n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "TradeExecuted",
              srcAddress: BOOK,
              logIndex: 5,
              block: { number: 63_617_142, timestamp: 1_800_000_002 },
              transaction: { hash: OTHER_TX_HASH },
              params: {
                poolId: POOL_ID,
                takerOrderId: OTHER_ORDER_ID,
                makerOrderId: ORDER_ID,
                baseAsset: BASE,
                quoteAsset: QUOTE,
                price: 428_000n,
                quantity: 2n,
                quoteQuantity: 856_000n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "TradingFeeCharged",
              srcAddress: BOOK,
              logIndex: 6,
              block: { number: 63_617_142, timestamp: 1_800_000_002 },
              transaction: { hash: OTHER_TX_HASH },
              params: {
                poolId: POOL_ID,
                orderId: OTHER_ORDER_ID,
                feePayer: OTHER_TRADER,
                quoteAsset: QUOTE,
                amount: 856n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "OrderPartiallyFilled",
              srcAddress: BOOK,
              logIndex: 7,
              block: { number: 63_617_142, timestamp: 1_800_000_002 },
              transaction: { hash: OTHER_TX_HASH },
              params: {
                poolId: POOL_ID,
                orderId: ORDER_ID,
                fillQuantity: 2n,
                remainingQuantity: 1n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "OrderFilled",
              srcAddress: BOOK,
              logIndex: 8,
              block: { number: 63_617_142, timestamp: 1_800_000_002 },
              transaction: { hash: OTHER_TX_HASH },
              params: {
                poolId: POOL_ID,
                orderId: OTHER_ORDER_ID,
                fillQuantity: 2n,
                totalFilledQuantity: 2n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "BookUpdated",
              srcAddress: BOOK,
              logIndex: 9,
              block: { number: 63_617_142, timestamp: 1_800_000_002 },
              transaction: { hash: OTHER_TX_HASH },
              params: {
                poolId: POOL_ID,
                bestBid: 428_000n,
                bestAsk: 0n,
                sequence: 2n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "OrderCancelled",
              srcAddress: BOOK,
              logIndex: 10,
              block: { number: 63_617_143, timestamp: 1_800_000_003 },
              transaction: { hash: CANCEL_TX_HASH },
              params: {
                orderId: ORDER_ID,
                poolId: POOL_ID,
                trader: TRADER,
                remainingQuantity: 1n,
              },
            },
            {
              contract: "SpotCLOB",
              event: "BookUpdated",
              srcAddress: BOOK,
              logIndex: 11,
              block: { number: 63_617_143, timestamp: 1_800_000_003 },
              transaction: { hash: CANCEL_TX_HASH },
              params: {
                poolId: POOL_ID,
                bestBid: 0n,
                bestAsk: 0n,
                sequence: 3n,
              },
            },
          ],
        },
      },
    });

    expect(testIndexer.chains[chainId].SpotCLOB.addresses).toContain(BOOK);

    const market = await testIndexer.Market.getOrThrow(POOL_ID);
    expect(market).toMatchObject({
      id: POOL_ID,
      book: BOOK,
      creator: TRADER,
      bestBid: 0n,
      bestAsk: 0n,
      lastPrice: 428_000n,
      lastTradeAt: 1_800_000_002,
      sequence: 3n,
      orderCount: 2n,
      openOrderCount: 0n,
      tradeCount: 1n,
      baseVolume: 2_000_000_000_000_000_000n,
      quoteVolume: 856_000n,
      quoteFees: 856n,
      tradingFeeBps: 25,
    });

    const order = await testIndexer.Order.getOrThrow(orderEntityId(BOOK, ORDER_ID));
    expect(order).toMatchObject({
      marketId: POOL_ID,
      trader: TRADER,
      side: "BUY",
      kind: "LIMIT",
      status: "CANCELLED",
      isOpen: false,
      filledQuantity: 2n,
      remainingQuantity: 1n,
      quoteQuantity: 856_000n,
    });

    const taker = await testIndexer.Order.getOrThrow(orderEntityId(BOOK, OTHER_ORDER_ID));
    expect(taker).toMatchObject({
      trader: OTHER_TRADER,
      side: "SELL",
      status: "FILLED",
      isOpen: false,
      filledQuantity: 2n,
      remainingQuantity: 0n,
      quoteQuantity: 856_000n,
    });

    const oneMinuteStart = candleStart(1_800_000_002, 60);
    const candle = await testIndexer.MarketCandle.getOrThrow(candleEntityId(POOL_ID, 60, oneMinuteStart));
    expect(candle).toMatchObject({
      marketId: POOL_ID,
      intervalSeconds: 60,
      startTimestamp: oneMinuteStart,
      endTimestamp: oneMinuteStart + 60,
      open: 428_000n,
      high: 428_000n,
      low: 428_000n,
      close: 428_000n,
      lotVolume: 2n,
      baseVolume: 2_000_000_000_000_000_000n,
      quoteVolume: 856_000n,
      tradeCount: 1,
    });

    expect(await testIndexer.MarketCandle.getAll()).toHaveLength(6);

    const hourlyStart = candleStart(1_800_000_002, 3_600);
    const hourlyStats = await testIndexer.MarketIntervalStats.getOrThrow(
      marketIntervalStatsEntityId(POOL_ID, 3_600, hourlyStart),
    );
    expect(hourlyStats).toMatchObject({
      marketId: POOL_ID,
      intervalSeconds: 3_600,
      orderPlacedCount: 2n,
      limitOrderCount: 2n,
      marketOrderCount: 0n,
      filledOrderCount: 1n,
      partialFillEventCount: 1n,
      cancelledOrderCount: 1n,
      tradeCount: 1n,
      openOrderCountStart: 0n,
      openOrderCountEnd: 0n,
      lotVolume: 2n,
      baseVolume: 2_000_000_000_000_000_000n,
      quoteVolume: 856_000n,
      quoteFees: 856n,
    });
    expect(await testIndexer.MarketIntervalStats.getAll()).toHaveLength(2);

    const update = await testIndexer.BookUpdate.getOrThrow(bookUpdateEntityId(POOL_ID, 3n));
    expect(update.txHash).toBe(CANCEL_TX_HASH);
  });
});
