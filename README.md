# CLOB

Turborepo workspace for a fully on-chain spot central limit order book on Monad.

## Workspace

- `apps/web` — Next.js trading interface using shadcn, Tailwind CSS, Motion, and Privy.
- `contracts` — Foundry package containing the initial exchange contract boundaries.
- `apps/indexer` — Envio HyperIndex service for markets, orders, trades, and candles.

The matching engine is on-chain. A bundler or paymaster may submit and sponsor user operations, but it
does not choose matches or maintain authoritative order-book state.

## Architecture decisions

- Order placement, cancellation, price-time matching, and settlement belong in Monad contracts.
- Privy handles Ethereum wallet authentication and connection. The local deployment asks the
  connected wallet to use the Anvil chain before submitting a transaction.
- The trading data is currently typed mock data. `contracts` contains implementation
  boundaries and security invariants; it does not yet contain the deployable matching engine.

## Development

```sh
pnpm install
pnpm dev:web
```

Run all workspace checks with:

```sh
pnpm check
pnpm test
pnpm build
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and add `NEXT_PUBLIC_PRIVY_APP_ID` from the Privy
dashboard. `NEXT_PUBLIC_PRIVY_CLIENT_ID` is optional and is only needed when using a Privy app client.
Enable wallet login and add the local development origin (for example `http://localhost:3001`) in the
Privy dashboard.

## Privy paymaster stress test

The web package includes a Monad Testnet-only stress harness that creates or reuses five
Privy-owned server wallets, provisions two disposable base tokens and two USDC markets, and submits
maker and taker batches from all five wallets in parallel. Every wallet request sets
`sponsor: true`; the run fails if Privy does not report every submission as sponsored or if a trader
pays native gas.

Configure `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, and the Monad paymaster in
`apps/web/.env.local`, then run:

```sh
pnpm --filter @clob/web stress:privy -- --dry-run
STRESS_ROUNDS=10 pnpm --filter @clob/web stress:privy
```

Use `--provision-only` to create and fund the reusable test setup without placing orders. Wallet
authorization keys and the latest JSON report are written with mode `0600` to ignored
`.env.privy-stress-*.json` files in `apps/web`.

## Live USDT/USDC market maker

The web package also includes a continuous Monad Testnet market maker for the deployed USDT/USDC
pool. It creates or reuses five Privy embedded/server wallets, claims both USDT and USDC from the
faucet, approves the pair-specific book, and submits each maker or taker wave from all five wallets
in parallel. Calls within one wallet are batched into one sponsored transaction so that its old
quotes are cancelled and replaced atomically.

```sh
# Validate the deployment and configuration without creating wallets or sending transactions.
pnpm --filter @clob/web maker:live -- --dry-run

# Create/fund/approve the five persistent Privy wallets, but do not quote yet.
pnpm --filter @clob/web maker:live -- --provision-only

# Run until Ctrl-C. Existing quotes remain on the book when the process exits.
pnpm --filter @clob/web maker:live

# Cancel all open orders owned by the five market-maker wallets.
pnpm --filter @clob/web maker:live -- --cleanup

# Execute one sponsored 1 USDT market sell from one Privy wallet without changing quotes.
pnpm --filter @clob/web maker:live -- --trade-only --sell
```

The default market is pool `0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c`
at the route `/10143/markets/<pool-id>/trade`. The precision-price stable-pair deployment defaults
to 20 bids from `0.995` down to `0.900` and 20 asks from `1.005` up to `1.100`, in `0.005` steps.
Override these with `MM_BID_PRICE`, `MM_ASK_PRICE`, and `MM_PRICE_STEP`. Every bid and ask level gets
an independently randomized size from `MM_MIN_ORDER_SIZE` (default `8` USDT) through
`MM_MAX_ORDER_SIZE` (default `40` USDT) on every refresh. `MM_ORDER_SIZE` remains available when a
fixed size is desired. Other useful controls are `MM_TAKER_SIZE` (default `1` USDT),
`MM_INTERVAL_MS` (default `5000`), `MM_TAKER_EVERY` (default every round),
`MM_TAKER_WALLET` (default wallet `5`; exactly one market trade per taker wave), `MM_LEVELS_PER_SIDE`
(20–50), and `MM_MAX_ROUNDS` (`0` means unlimited). Set `MM_CANCEL_ON_EXIT=true` to withdraw all
resting quotes on shutdown. The state and rolling report are private ignored files in
`apps/web/.env.privy-market-maker-*.json`.
