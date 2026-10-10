# `@clob/contracts`

Foundry package for the fully on-chain spot central limit order book (CLOB) on Monad.

Security findings, remediation status, regression coverage, and residual risks are documented in
the [initial audit and remediation report](docs/initial-audit-invariant.md).

`SpotCLOB` is a fully on-chain matching engine with per-order escrow. New markets use a sparse
16-level radix tree over the full `uint128` price domain. A doubly linked FIFO queue at each active
price preserves price-time priority and supports O(1) cancellation. Legacy bitmap markets remain
supported for backwards compatibility.

`SpotCLOBFactory` owns an administrator-managed quote-token allowlist and the canonical ordered
base/quote pair identity. Anyone can deploy a pair whose quote token is currently allowed. The
factory creates one deterministic minimal-proxy `SpotCLOB` per pair with CREATE2, activates it
atomically, records the book address, and exposes indexed enumeration for market discovery. Removing a quote token
blocks new pairs without disabling books that already exist. `PoolRegistry` remains as a
backwards-compatible contract name for the same factory implementation.

Market creation can carry an owner-configurable native MON fee. It defaults to zero, is stored as
wei in `marketCreationFee`, and every pair-creation overload requires the caller to send the exact
configured amount. The owner can collect accrued MON with `withdrawMarketCreationFees`. This fee
is separate from per-market trading fees, which continue to be assessed in the quote token.
Each order snapshots the market fee when it is accepted. Later fee updates apply only to newly
submitted orders, so a resting bid's reserved fee always remains sufficient for its fills.

The default two-address creation path is supply agnostic: price is quote tokens per whole base
token with 18 fixed decimals (`priceX18`), while quantity is raw base-token atoms. This provides a
single price range from `1e-18` to approximately `3.402823669e20` quote tokens per base token.
The minimum quantity changes with price so every accepted order settles at least one quote-token
atom. For six-decimal USDC, that minimum order value is `0.000001 USDC`.

Legacy creation overloads can derive a pair's base lot from administrator-controlled decimal precision or accept
an explicit `uint128` raw lot size at pair creation. The explicit form supports multi-token lots,
which let markets quote a per-token price below one quote-token atom while keeping every settlement
in whole token atoms. The default derived precision is eight decimal places. The owner can update
the fallback with `setDefaultLotDecimals`, set or replace a pre-creation pair override with
`setPairLotDecimals`, and return a pending pair to the fallback with `clearPairLotDecimals`. Tokens
with fewer decimals use their full native precision. Pair sizing is immutable after creation.

In legacy markets, prices are quote-token atoms per base lot and quantities are integer lot counts. For example, a market
with a `0.001 WETH` lot and USDC as quote token expresses a `$2,500/WETH` order as a price of
`2_500_000` USDC atoms per lot and a quantity of `1_000` lots for one WETH. `tickSize` constrains
valid prices, while `lotSize` converts filled quantities into raw base-token amounts.

For a six-decimal quote token, the minimum settled quote amount is one atom (`0.000001` USDC). An
explicit lot of `100_000e18` raw units for an 18-decimal base token lets a one-atom lot price express
`0.00000000001` USDC per base token; the minimum order at that floor trades 100,000 base tokens.

Account abstraction, session keys, transaction sponsorship, and wallet UX remain outside the
matching interface. Traders approve the pair contract as an ERC-20 spender; placing an order then
pulls the order's maximum input amount from the trader's wallet. Every limit-order entry point
measures the received balance delta and reduces the stored order to the maximum funded quantity.
This treats a recipient-side transfer tax as part of the token's economics; `OrderQuantityAdjusted`
reports any difference between requested and accepted quantity. Fills send output tokens directly
to both traders, price improvement is returned immediately, and cancellation returns unused escrow
directly to the order owner's wallet. Before accepting or matching an order, the book verifies that
both market assets cover aggregate escrow and fee liabilities. An insolvent market rejects trading
with `MarketInsolvent`; order owners may still cancel, receiving the pro-rata recoverable value of
their remaining escrow. If a resting maker cannot receive a payout,
the fill attempt rolls back atomically, the order is marked quarantined and immediately unlinked
from the FIFO queue, and matching continues at the next executable order. The owner can later
release all remaining escrow with `closeQuarantinedOrder(orderId, receiver)`. A quarantined order
remains stored only as an escrow-recovery record with `resting == false`; no separate book cleanup
is required. There is no general-purpose deposit or withdrawal balance.

Market orders accept a worst price, a minimum fill, and `minReceive`. For a buy, `minReceive` is
raw base-token atoms actually received after any recipient-side transfer tax. For a sell, it is raw
quote-token atoms actually received after per-fill taker fees and any recipient-side transfer tax.
An unmet minimum reverts the entire operation. Setting `minReceive` to zero disables only that
output check: the market order still requires at least one fill, observes the price limit and
book-step cap, and may fill partially when `minFillQuantity` is also zero. Wallet-funded market
inputs remain exact-transfer only so a short transfer can never consume another order's pooled
escrow. Market orders never rest on the book. A zero price limit uses the configured pool boundary.

The read interface exposes aggregated, sorted top-N price levels through `getOrderBook(poolId,
depth)`, capped at 256 levels per side, as well as best-price and individual-level views. State
events are granular, and `BookUpdated` publishes best bid/ask plus a monotonic per-pool sequence.

`SpotCLOBLens` is a stateless optional read aggregator. It batches market metadata, sequence, best
prices, top-N depth, order state/links, and paginated user orders into fewer RPC calls. It calls the
book's stable view API; an EVM contract cannot directly inspect another contract's private storage
slots. Off-chain indexers may read raw slots through RPC, but those reads are storage-layout coupled.

## Book layout

```text
                         ON-CHAIN CLOB
                               │
                  ┌────────────┴────────────┐
                  │                         │
                BIDS                      ASKS
          highest price first       lowest price first
                  │                         │
        hierarchical bitmap       hierarchical bitmap
                  │                         │
             price levels               price levels
                  │                         │
          FIFO order queues          FIFO order queues
                  │                         │
                  └──────── MATCH ────────┘
                               │
                        Order Escrow
```

## Security invariants for implementation

- Every state transition is deterministic and derives from on-chain order-book state.
- A fill can never exceed either order's remaining quantity, and each order's filled quantity is
  monotonic and bounded by its original quantity.
- Matching is price-time priority within a single base/quote market; an order cannot skip a better
  resting price or an earlier order at the same price.
- Only the order owner can cancel an open resting order; cancelling a filled or already-cancelled
  order reverts and cannot resurrect quantity.
- Aggregate escrow liabilities equal the sum of trader locked balances. Trading requires contract
  balances to cover escrow and accrued-fee liabilities; an external balance reduction instead
  enters proportional order-close recovery.
- Settlement is atomic: base and quote movements and order-state updates either all succeed or all
  revert.
- A failed maker payout quarantines only that maker order; failed taker receipts revert the taker's
  transaction and cannot remove an innocent resting order.
- Reentrancy, token transfer failures, fee-on-transfer behavior, and unsupported token behavior are
  handled explicitly before production deployment.
- Market configuration, numeric precision, GTC-only order policy, replay protection, and
  authorization checks are validated on-chain and covered by invariant and fuzz testing.

## Development

```sh
forge build
forge test
forge fmt --check
forge coverage --no-match-contract SpotCLOBInvariantTest --skip script --ir-minimum --report summary
```

The current production sources report 97.19% line, 95.94% statement, 86.55% branch, and 98.72%
function coverage. The stateful invariant suite is run separately because coverage instrumentation
does not preserve the production optimizer configuration.

### Property and invariant tests

`PriceTreeTest` compares randomized insertion, deletion, membership, extrema, and successor /
predecessor lookups against an independent set over the full `uint128` domain. `SpotPriceMathTest`
checks rounding, minimum-quantity saturation, and supported / rejected decimal relationships.

`AgnosticPropertiesTest` checks randomized price-time matching, cancellation, per-fill fees,
market price / minimum-output protections, atomic rollback, GTC behavior, and fee withdrawals.
`AgnosticInvariantTest` mixes limit and market orders in both directions, authorized and unauthorized
cancellations, time advances, fee updates, and fee withdrawals across eight sparse prices from
`1e7` to `type(uint128).max`. It checks wallet conservation, escrow liabilities derived from
remaining orders, independently tracked snapshotted fee reserves and accrued maker/taker fees,
monotonic fills, closed-order finality, FIFO links, and radix / price-level consistency. Unexpected
handler reverts fail invariant campaigns.
`ArithmeticBoundsTest` exercises full-width prices and quantities, checked price-level accumulation,
atomic rollback on overflow, unfunded transfers, and the highest supported decimal denominator.

Run a bounded campaign without changing the default fuzz run count:

```sh
FOUNDRY_INVARIANT_RUNS=32 FOUNDRY_INVARIANT_DEPTH=64 forge test
```

`forge test` uses Foundry's default campaign sizes (256 fuzz runs and 256 invariant sequences of
depth 500). These are randomized checks, not formal proofs; no formal verification runner is wired
into this repository.

Known limitations reproduced by tests:

- Agnostic markets accept every positive `priceX18`, so improving a bid by one price unit creates
  a separate level and outranks an earlier bid even when both settle to the same quote atoms.
- The current minimum is one quote-token atom: `0.000001 USDC` for a six-decimal quote token.
  A one-USDC minimum notional and a relative tick grid are not currently enforced.

### Immediate-unlink stress benchmark

`testGasM02HundredBlockedOrdersAreUnlinkedDuringMatching` places 100 blocked makers ahead of one
valid maker at the same price. The optimized local EVM measurement from 10 October 2026 is:

| Action | Gas |
| --- | ---: |
| Unlink 100 blocked makers and fill the next valid order | 5,928,959 |
| Match the next order after immediate unlinking | 325,394 |

The stress match explicitly sets `maxBookSteps` to 101. The default remains 64; callers processing
a larger blocked prefix must select a sufficient bound and pay the corresponding gas.

### Supply-agnostic gas benchmark

Run the transaction-style benchmark with:

```sh
forge test --match-path test/AgnosticGasBenchmark.t.sol --gas-report -vv
```

The optimized local EVM snapshot from 27 September 2026 uses the current `SpotCLOB`
with `minReceive` support. Market-order scenarios set `minReceive = 0`.

| Scenario | Gas | Quotes consumed | Gas per quote |
| --- | ---: | ---: | ---: |
| Create agnostic market clone | 467,953 | 1 | 467,953 |
| Place first order at a new price | 750,261 | 1 | 750,261 |
| Place another order at the same price | 322,548 | 1 | 322,548 |
| Cancel an order | 154,926 | 1 | 154,926 |
| Market buy consuming one ask | 475,917 | 1 | 475,917 |
| Market buy consuming 50 asks | 6,262,649 | 50 | 125,252 |
| Market sell consuming 50 bids | 7,303,789 | 50 | 146,075 |
| Read best prices from a 50-level book | 59,746 | 1 | 59,746 |
| Read 50 levels per side | 1,624,997 | 50 | 32,499 |

The same run reports direct contract-call gas as follows. Ranges reflect different book states used
by the benchmark; view-call gas matters to RPC capacity even though an off-chain `eth_call` does not
charge the caller.

| Function | Min | Median | Max |
| --- | ---: | ---: | ---: |
| `SpotCLOB.initialize` | 90,167 | 90,167 | 90,167 |
| `SpotCLOB.activatePool` | 124,876 | 124,876 | 124,876 |
| `SpotCLOB.placeLimitOrderWithMaxBookSteps` | 294,120 | 462,711 | 734,909 |
| `SpotCLOB.cancelOrder` | 134,424 | 134,424 | 134,424 |
| `SpotCLOB.executeMarketOrder` | 538,875 | 7,790,878 | 9,092,276 |
| `SpotCLOB.getMarket` | 10,518 | 10,518 | 10,518 |
| `SpotCLOB.getBestPrices` | 53,896 | 53,896 | 53,896 |
| `SpotCLOB.getOrderBook(50)` | 1,594,009 | 1,594,009 | 1,594,009 |
| `SpotCLOBFactory.createPair` | 467,357 | 467,357 | 467,357 |
| `SpotCLOBLens.minimumOrderQuantity` | 19,336 | 19,336 | 19,336 |
| `SpotCLOBLens.quoteAmount` | 19,347 | 19,347 | 19,347 |

These figures measure the requested operation after fixture setup; the 50-quote market-order rows do
not include gas used to seed the 50 resting makers. They are comparative EVM gas measurements, not a
MON-denominated transaction-fee estimate.

## Local Anvil deployment for the web UI

The deployment script creates a complete local market: mintable `MON`, `USDC`, and `USDT`, a
`TokenFaucet`, `SpotCLOBFactory`, one pair-specific `SpotCLOB`, four funded/approved actors, and two
non-crossing levels on each side of the book. This is for local development only. The mock tokens are
unrestricted and the keys below are public Anvil development keys; never use them on a public or
production chain.

From a fresh terminal, start Anvil with the exact mnemonic used by the script:

```sh
cd contracts
anvil --host 127.0.0.1 --port 8545 \
  --code-size-limit 131072 \
  --mnemonic 'test test test test test test test test test test test junk' \
  --accounts 5
```

In a second terminal, deploy and seed the market:

```sh
cd contracts
forge script script/DeployAnvil.s.sol:DeployAnvil \
  --rpc-url http://127.0.0.1:8545 --broadcast
```

The script reverts unless the chain ID is `31337`. It allows USDC as a quote token, creates the
MON/USDC pair, and prints and verifies `getBestPrices(poolId)` and `getOrderBook(poolId, 4)` after
seeding. The checked-in UI configuration is [deployments/anvil.json](deployments/anvil.json).

### ERC-20 faucet

`TokenFaucet` is a reserve-backed, multi-token faucet. The local deployment configures both mock
USDC and USDT to pay `10_000e6` (10,000 tokens) to `msg.sender`, once per token per day. It also
funds the faucet with 1,000,000 of each token. Call it with the token address printed by the deploy
script:

```sh
cast send <FAUCET_ADDRESS> "claim(address)" <USDC_OR_USDT_ADDRESS> \
  --private-key <PRIVATE_KEY> --rpc-url http://127.0.0.1:8545
```

The faucet owner can add or update any standard ERC-20 with
`configureToken(token, claimAmount, cooldown)`. Amounts are exact token base units, avoiding an
unsafe assumption that every ERC-20 uses the same number of decimals. Anyone may fund the faucet by
transferring configured tokens directly to its address.

### ERC-20 token factory

`ERC20TokenFactory` lets any caller deploy a `MintableERC20` with a chosen name, symbol, decimals,
and initial supply:

```solidity
address token = factory.createToken("Example USD", "xUSD", 6, 1_000_000e6);
```

The caller becomes the token owner, receives the entire initial supply, and is the only account
allowed to call `mint`. Minting ownership can later be moved with `transferOwnership`. The factory
indexes every deployed token globally and per creator. The local Anvil script deploys the factory
and prints its address.

To use a factory-created token with `TokenFaucet`, transfer or mint reserves to the faucet address,
then have the faucet owner call `configureToken(token, 10_000e6, 1 days)` for a six-decimal token.

### UI configuration

Use these values with the generated contract ABIs in `out/`:

| Setting | Value |
| --- | --- |
| Chain ID | `31337` |
| RPC URL | `http://127.0.0.1:8545` |
| MON | `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0` |
| USDC | `0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82` |
| SpotCLOBFactory | `0x9A676e781A523b5d0C0e43731313A708CB607508` |
| Pair SpotCLOB | `0xd356F66e2B971E774a3D86Db1B67C5D9BA48F772` |
| Pool ID | `0x940fa4f561e904023d97c99693c926e617384e35a8001be8c408a507c2d04645` |

The current checked-in addresses were deployed onto the existing local Anvil chain beginning at
block `18196`. Restarting Anvil resets them; rerun the script and update the web environment from
its printed values. The pool uses `lotSize = 1e18`, `tickSize = 1e3`, `minTick = 1`, and
`maxTick = 1_000_000`.
Prices are quote-token atoms per MON lot, so the seeded best bid is `428000` (0.428 USDC) for
quantity `3`, and the seeded best ask is `429000` (0.429 USDC) for quantity `2`. Query the book
with `getBestPrices(poolId)` and `getOrderBook(poolId, depth)`.

## Monad Testnet deployment

`DeployWalletNativeMonadTestnet.s.sol` deploys the current factory and lens, allows the project's
USDC, and creates DUMMY1/USDC, USDT/USDC, and MON/USDC markets. Use a Foundry keystore account:

```sh
forge script \
  script/DeployWalletNativeMonadTestnet.s.sol:DeployWalletNativeMonadTestnet \
  --rpc-url https://testnet-rpc.monad.xyz \
  --account <keystore-name> \
  --broadcast
```

The script requires chain ID `10143` and does not read a private key from an environment variable.
Current addresses and transaction hashes are in [`deployments/monad-testnet.json`](deployments/monad-testnet.json).

Deploy the permissionless ERC-20 factory and a funded test-token faucet with:

```sh
export PRIVATE_KEY=0x...
forge script script/DeployTokenToolsMonadTestnet.s.sol:DeployTokenToolsMonadTestnet \
  --rpc-url https://testnet-rpc.monad.xyz \
  --broadcast
```

This deployment creates mock six-decimal USDC and USDT through the factory, configures 10,000-token
claims with a one-day per-address cooldown, and funds the faucet with 10,000,000 of each token. The
current addresses and transaction hashes are recorded in
[`deployments/token-tools-monad-testnet.json`](deployments/token-tools-monad-testnet.json).

The deterministic actors are Anvil accounts 1–4 from the mnemonic above: sellers at
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8` and
`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`, buyers at
`0x90F79bf6EB2c4f870365E785982E1f101E93b906` and
`0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65`. Their private keys are intentionally embedded only
for this Anvil script and must not be reused elsewhere.

The package has no external Solidity dependencies.

## Current limitations

- Tick parameters are selected by the first permissionless creator of an allowed-quote pair. A
  production registry should use governance-approved tick parameters if configuration squatting
  is unacceptable. Lot precision is administrator-controlled and cannot be supplied by creators.
- Quote-token removal only prevents future pair creation; existing books deliberately remain live.
- Limit orders are good-til-cancelled. The ABI retains the `expiry` field for compatibility, but the
  contract rejects every non-zero value.
- Self-trade prevention, native-token handling, upgradeability, and governance transfer are
  intentionally not implemented.
- Limit-order funding supports conventional recipient-tax tokens by measuring actual balance
  deltas. Negative rebases are contained by a live solvency gate and proportional cancellation;
  positive rebases are not assigned to order owners. Sender-surcharge, reflection/reward, and
  otherwise mutable or malicious token accounting remain unsupported.
- This is an unaudited reference implementation, not production-ready order escrow.
