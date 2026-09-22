# Onchain Spot Orderbook

A fully on-chain spot central limit order book on Monad. Orders, price-time matching, settlement,
and custody are enforced by smart contracts. The web app provides Privy wallet access, sponsored
transactions, live market data, and trading tools.

## Features

- Limit and market orders with price-time priority
- Per-order escrow with atomic settlement and cancellation
- Sponsored ERC-4337 UserOperations for Monad Testnet transactions
- Browser-local Kernel session keys authorized when the user signs in
- Live order books, trades, candles, and market statistics through Envio
- Permissionless token and market creation
- Local Anvil support for contract and UI development

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
| SpotCLOBFactory | [`0x50fcEa11c0F01F0eeAa5E980dc4ae9977559330b`](https://testnet.monadscan.com/address/0x50fcEa11c0F01F0eeAa5E980dc4ae9977559330b) |
| SpotCLOBLens | [`0xDD090DDa847b9BB8f71e4de2Bc3AA74efA528e0F`](https://testnet.monadscan.com/address/0xDD090DDa847b9BB8f71e4de2Bc3AA74efA528e0F) |
| ERC20TokenFactory | [`0x898fcCf695D6f3a23B8Ef9F4d7C3EAf97ba837Cc`](https://testnet.monadscan.com/address/0x898fcCf695D6f3a23B8Ef9F4d7C3EAf97ba837Cc) |
| TokenFaucet | [`0xB8d1b7f2a722A0b5315eaF0840F652A95a758598`](https://testnet.monadscan.com/address/0xB8d1b7f2a722A0b5315eaF0840F652A95a758598) |

Chain ID: `10143`

## Monad gas benchmark

- Gas price: `102 Gwei` (`0.000000102 MON/gas`)
- USD reference: `0.003016344 MON = $0.000076`

Fixture seeding is excluded from measured gas.

| Action | Book before | Levels before | Matches | Total gas | Gas/match | Fee (MON) | Fee (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Create limit, new price level | 0 | 0 | 0 | 732,562 | — | 0.074721324 | $0.001883 |
| Create limit, existing price level | 1 | 1 | 0 | 212,944 | — | 0.021720288 | $0.000547 |
| Cancel one resting order | 1 | 1 | 0 | 49,487 | — | 0.005047674 | $0.000127 |
| Fill one resting order, limit | 1 | 1 | 1 | 491,659 | 491,659 | 0.050149218 | $0.001264 |
| Market fill, 100 orders at one level | 100 | 1 | 100 | 9,112,030 | 91,120 | 0.929427060 | $0.023418 |
| Market fill, 50 orders in a dense book | 2,000 | 1,000 | 50 | 4,981,412 | 99,628 | 0.508104024 | $0.012802 |
| Market fill, 100 orders in a dense book | 2,000 | 1,000 | 100 | 9,651,622 | 96,516 | 0.984465444 | $0.024805 |
| Market fill, 200 orders in a dense book | 2,000 | 1,000 | 200 | 19,004,010 | 95,020 | 1.938409020 | $0.048840 |

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
