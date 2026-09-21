# `@clob/indexer`

Envio HyperIndex v3 indexer for the spot CLOB contracts. It discovers pair-specific `SpotCLOB`
contracts from the factory's `PairCreated` event and exposes markets, orders, trades, OHLCV
candles, and book updates through Envio's generated GraphQL API.

The default Monad Testnet configuration uses HyperSync as the primary historical and realtime
source. The public RPCs listed in the official Monad documentation—Ankr and Monad Foundation—are
configured as fallbacks. Historical Ankr `eth_getLogs` requests are capped at 999 block intervals
(at most 1,000 inclusive blocks), reducing request volume while staying within its public endpoint
limit. The lower-capacity Foundation endpoint is not used for historical fallback because Envio's
parallel loaders can exceed its public rate limit. This setup does not require an Envio HyperSync
API token.

Override either provider without editing the config by setting `ENVIO_MONAD_SYNC_RPC_URL`,
`ENVIO_MONAD_REALTIME_RPC_URL`, or `ENVIO_MONAD_REALTIME_WS_URL`. A custom sync provider must accept
`eth_getLogs` ranges of 1,000 blocks, or its interval settings in `config.yaml` must be lowered to
match the provider.

Realtime indexing runs at the chain head (Envio's persisted `block_lag: 0` default). Reorg rollback
is explicitly enabled and the existing database retains Envio's 200-block detection window, so data
from a replaced fork is rolled back and replayed from the canonical chain rather than waiting for
confirmed or finalized blocks.

`pnpm dev` and `pnpm start` automatically restart Envio with capped exponential backoff when it
exits after a transient RPC/network failure, including HTTP 429 rate limits. They still exit
immediately for non-retryable errors. Use `pnpm dev:once` or `pnpm start:once` when a supervisor
already owns restart behavior.

Each trade updates 1-minute, 5-minute, 15-minute, 1-hour, 4-hour, and 1-day `MarketCandle`
entities. Candle prices are quote-token atoms per base lot. `lotVolume` is the traded lot count,
`baseVolume` is the raw base-token amount, and `quoteVolume` is the raw quote-token amount.

`MarketIntervalStats` provides hourly (`3600`) and daily (`86400`) time series for placed, limit,
market, filled, partial-fill, and cancelled-order events; trades; opening and closing open-order
counts; and lot/base/quote volume. `Market` also keeps all-time totals, the current open-order count,
and the latest trade price and timestamp.

Every fill charges the taker 10 basis points in the quote token. `TradingFeeCharged` events update
the all-time and interval `quoteFees` totals. Fees are rounded down to the quote token's smallest
unit, so very small fills can have a zero-atom fee.

## Requirements

- Node.js 22+
- pnpm
- Docker Desktop for `envio dev`

## Monad Testnet

```sh
pnpm install
pnpm codegen
pnpm dev
```

The default config starts at factory deployment block `63617140` and dynamically registers books
created by `0x50fcEa11c0F01F0eeAa5E980dc4ae9977559330b`.

The current deployment emits the latest event signatures. The indexer also retains handlers for
the legacy eight-field `PairCreated` and seven-field `MarketActivated` signatures so historical or
local legacy deployments remain compatible.

## Local Anvil

Start Anvil and run the contracts package's `DeployAnvil` script first. The checked-in local config
uses the addresses and start block in `../../contracts/deployments/anvil.json`.

```sh
pnpm install
pnpm codegen:local
pnpm dev:local
```

If Anvil was restarted and the contracts were redeployed, update the factory address and
`start_block` in `config.local.yaml` from the new deployment output.

## Checks

```sh
pnpm check
pnpm test
```

Run `pnpm codegen` whenever `config.yaml` or `schema.graphql` changes. Run
`pnpm codegen:local` after changing `config.local.yaml`.

## UI candle query

Query a market's one-minute candles in ascending time order:

```graphql
query MarketCandles($marketId: String!, $from: Int!, $limit: Int!) {
  MarketCandle(
    where: {
      marketId: { _eq: $marketId }
      intervalSeconds: { _eq: 60 }
      startTimestamp: { _gte: $from }
    }
    order_by: { startTimestamp: asc }
    limit: $limit
  ) {
    startTimestamp
    open
    high
    low
    close
    baseVolume
    quoteVolume
    tradeCount
  }
}
```

## Market creation list

Markets are indexed directly from `PairCreated`, including creation time, block, transaction, and
the transaction sender when the data source provides it.

```graphql
query Markets($limit: Int!, $offset: Int!) {
  Market(order_by: { createdAt: desc }, limit: $limit, offset: $offset) {
    id
    book
    baseAsset
    quoteAsset
    lotSize
    tickSize
    minTick
    maxTick
    creator
    createdAt
    createdBlock
    createdTxHash
    lastPrice
    lastTradeAt
    openOrderCount
    tradeCount
    baseVolume
    quoteVolume
    quoteFees
  }
}
```

## Hourly or daily market statistics

Use `intervalSeconds: 3600` for hourly rows or `86400` for daily rows.

```graphql
query MarketStats($marketId: String!, $interval: Int!, $from: Int!) {
  MarketIntervalStats(
    where: {
      marketId: { _eq: $marketId }
      intervalSeconds: { _eq: $interval }
      startTimestamp: { _gte: $from }
    }
    order_by: { startTimestamp: asc }
  ) {
    startTimestamp
    endTimestamp
    orderPlacedCount
    limitOrderCount
    marketOrderCount
    filledOrderCount
    partialFillEventCount
    cancelledOrderCount
    openOrderCountStart
    openOrderCountEnd
    tradeCount
    lotVolume
    baseVolume
    quoteVolume
    quoteFees
  }
}
```
