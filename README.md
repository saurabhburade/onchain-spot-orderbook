# Onchain Spot Orderbook

A fully on-chain spot central limit order book on Monad. Orders, price-time matching, settlement,
and custody are enforced by smart contracts. The web app provides Privy wallet access, sponsored
transactions, live market data, and trading tools.

## Problem

Most on-chain spot markets use AMMs or off-chain matching. This project provides a permissionless,
non-custodial spot CLOB on Monad with transparent price-time matching, escrow, and settlement
entirely on-chain.

## Intended users

- Traders seeking transparent, non-custodial limit and market orders
- Token creators launching permissionless spot markets
- Builders exploring on-chain matching and sponsored transactions on Monad

## Technology stack

| Layer | Technology |
| --- | --- |
| Blockchain | Monad Testnet, Solidity, Foundry |
| Smart accounts | ERC-4337 UserOperations, EIP-7702 delegation, Kernel session keys |
| Web application | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui, Motion |
| Wallet and transactions | Privy, Viem |
| Indexing and data | Envio HyperIndex, GraphQL |
| Tooling and tests | pnpm, Turborepo, Biome, Node.js test runner, Vitest, Forge |

## Features

- Limit and market orders with price-time priority
- Market-order slippage tolerance and an on-chain minimum received amount
- Per-order escrow with atomic settlement and cancellation
- Sponsored ERC-4337 UserOperations for Monad Testnet transactions
- Browser-local Kernel session keys authorized when the user signs in
- Live order books, trades, candles, and market statistics through Envio
- Permissionless token and market creation
- Local Anvil support for contract and UI development

## Demo

[Watch the public proof-of-concept video on X](https://x.com/saurabh_evm/status/2102428560334151828)
or [open the live Monad Testnet app](https://clob.bsaurabh.xyz/10143/markets).

The demo shows the fully on-chain order book, permissionless market creation, and real-time price
matching running on Monad.

## Architecture

| Package | Purpose |
| --- | --- |
| `apps/web` | Next.js trading interface, Privy wallet integration, and UserOperation relay |
| `contracts` | Foundry project containing the order book, factory, lens, faucet, and token factory |
| `apps/indexer` | Envio HyperIndex service for markets, orders, trades, candles, and statistics |

The contracts are the source of truth. The indexer serves query-friendly market data but does not
participate in matching or settlement.

### Transaction flow

On Monad Testnet, the user's Privy EIP-7702 wallet authorizes an in-memory Kernel session key during
the login lifecycle. Transactions are then prepared and signed locally in the browser. The relay
validates the requested calls, simulates the UserOperation, and submits `EntryPoint.handleOps` from
the server sponsor wallet. The API returns the transaction hash without waiting for confirmation.

The session key remains in browser memory and is renewed in the background. The server never holds
the user's wallet or session private key.

## Monad Testnet deployment

| Contract | Address |
| --- | --- |
| SpotCLOBFactory | [`0x76853062bfDCCe89B7FFD92B3A23B858fe94DfAB`](https://testnet.monadscan.com/address/0x76853062bfDCCe89B7FFD92B3A23B858fe94DfAB) |
| SpotCLOBLens | [`0x6624c1f0580f8D70fF10C1CE85895Fe38c4CE402`](https://testnet.monadscan.com/address/0x6624c1f0580f8D70fF10C1CE85895Fe38c4CE402) |
| Default USDT/USDC book | [`0xFA343f5221933C6c2a9fd0d951dC9125BF81B7B3`](https://testnet.monadscan.com/address/0xFA343f5221933C6c2a9fd0d951dC9125BF81B7B3) |
| ERC20TokenFactory | [`0x898fcCf695D6f3a23B8Ef9F4d7C3EAf97ba837Cc`](https://testnet.monadscan.com/address/0x898fcCf695D6f3a23B8Ef9F4d7C3EAf97ba837Cc) |
| TokenFaucet | [`0xB8d1b7f2a722A0b5315eaF0840F652A95a758598`](https://testnet.monadscan.com/address/0xB8d1b7f2a722A0b5315eaF0840F652A95a758598) |

Chain ID: `10143`. Current market addresses and transaction hashes are in
[`contracts/deployments/monad-testnet.json`](contracts/deployments/monad-testnet.json).

The current market-order contract checks `minReceive` against raw base-token atoms for buys and
quote-token atoms received after fees for sells. Setting it to zero removes the output minimum;
the order still needs liquidity and can fill partially.

## Monad gas benchmark

Measured on the current `SpotCLOB` contract with `minReceive` support using
`forge test --match-contract EVMOrderActionBenchmarkTest -vv` on 27 September 2026.
The market-order scenarios use `minReceive = 0`. Fixture seeding is excluded from
measured gas. These are gas deltas around the actor-to-book calls in the Foundry
harness, not deployed transaction receipts.

- Monad Testnet gas price at measurement: `102 Gwei` (`0.000000102 MON/gas`)
- Illustrative USD conversion: `$0.02668/MON` ([CoinGecko](https://www.coingecko.com/en/coins/monad), 27 September 2026)

| Action | Book before | Levels before | Matches | Total gas | Gas/match | Fee (MON) | Fee (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Create limit, new price level | 0 | 0 | 0 | 732,580 | — | 0.074723160 | $0.001994 |
| Create limit, existing price level | 1 | 1 | 0 | 212,962 | — | 0.021722124 | $0.000580 |
| Cancel one resting order | 1 | 1 | 0 | 49,487 | — | 0.005047674 | $0.000135 |
| Fill one resting order, limit | 1 | 1 | 1 | 492,175 | 492,175 | 0.050201850 | $0.001339 |
| Market fill, 100 orders at one level | 100 | 1 | 100 | 9,161,878 | 91,618 | 0.934511556 | $0.024933 |
| Market fill, 50 orders in a dense book | 2,000 | 1,000 | 50 | 5,006,360 | 100,127 | 0.510648720 | $0.013624 |
| Market fill, 100 orders in a dense book | 2,000 | 1,000 | 100 | 9,701,470 | 97,014 | 0.989549940 | $0.026401 |
| Market fill, 200 orders in a dense book | 2,000 | 1,000 | 200 | 19,103,658 | 95,518 | 1.948573116 | $0.051988 |

## Development

### Requirements

- Node.js 22+
- pnpm 10+
- Foundry for contract development
- Docker for the local Envio indexer

### Setup

```sh
pnpm install
cp apps/web/.env.example apps/web/.env.local
pnpm dev
```

Use `pnpm dev:web` to run only the web app. Configure wallet login and the local origin in the Privy
dashboard before signing in.

The main web configuration is:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy application ID |
| `PRIVY_APP_SECRET` | Server-side Privy authentication |
| `PRIVY_JWT_VERIFICATION_KEY` | Optional local verification of Privy access tokens |
| `SPONSER_PK` | Server sponsor wallet used to submit `EntryPoint.handleOps` |
| `ENVIO_GRAPHQL_URL` | Envio GraphQL endpoint |
| `NEXT_PUBLIC_MONAD_RPC_URLS` | Optional ordered Monad RPC overrides |
| `NEXT_PUBLIC_GOOGLE_ANALYTICS_ID` | Optional GA4 measurement ID |

Keep `PRIVY_APP_SECRET` and `SPONSER_PK` server-side. See
[`apps/web/.env.example`](apps/web/.env.example) for the complete configuration.

## Verification

```sh
pnpm check
pnpm test
pnpm build
```

Contract checks can also be run directly:

```sh
cd contracts
forge fmt --check
forge build
forge test
```

See [`contracts/README.md`](contracts/README.md) for contract design and deployment details, and
[`apps/indexer/README.md`](apps/indexer/README.md) for indexer configuration and GraphQL examples.

## License

This project is open source under the [MIT License](LICENSE).

*AI assistance: This project was developed with assistance from OpenAI Codex using GPT-5.6 Sol.*
