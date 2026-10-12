# Initial Smart Contract Audit and Remediation Report

## Report metadata

| Field | Value |
| --- | --- |
| Project | Onchain Spot Orderbook |
| Component | `SpotCLOB`, factory, pricing libraries, and Solidity test suite |
| Original reviewer | [@0x3b33](https://github.com/0x3b33) |
| Remediation branch | [`initial-audit-invariant`](https://github.com/saurabhburade/onchain-spot-orderbook/tree/initial-audit-invariant) |
| Remediation PR | [#2 — Initial audit invariants and liveness fixes](https://github.com/saurabhburade/onchain-spot-orderbook/pull/2) |
| Report revision | 12 October 2026 |
| Verified code revision | [`fe824dd`](https://github.com/saurabhburade/onchain-spot-orderbook/commit/fe824dd) |
| Verification workflow | [GitHub Actions run 38285571890](https://github.com/saurabhburade/onchain-spot-orderbook/actions/runs/38285571890) |
| Solidity version | 0.8.24 |

## Executive summary

The initial review reported eleven findings: one high-severity, three medium-severity, two
low-severity, and five informational findings. This branch fixes ten findings. The remaining
informational finding, I-02, is accepted as a documented settlement policy and bounded by fuzz
tests.

The remediation also adds support for conventional recipient-tax tokens, aggregate escrow
liability accounting, adversarial token-behavior tests, and three stateful invariant campaigns.

| Severity | Reported | Fixed | Accepted | Open |
| --- | ---: | ---: | ---: | ---: |
| High | 1 | 1 | 0 | 0 |
| Medium | 3 | 3 | 0 | 0 |
| Low | 2 | 2 | 0 | 0 |
| Informational | 5 | 4 | 1 | 0 |
| **Total** | **11** | **10** | **1** | **0** |

### Status definitions

- **Fixed** — runtime remediation is implemented and covered by a regression test.
- **Accepted** — the behavior is retained as an explicit design policy, documented, and bounded by
  regression or property tests.
- **Open** — the reported behavior remains and requires a future code or documentation change.

## Scope and methodology

The review and remediation cover the order-book implementation, pair factory, pricing and tree
libraries, token settlement boundaries, and their externally visible invariants. The validation
work combines:

- deterministic proof-of-concept and regression tests;
- fuzz tests for arithmetic, pricing, token-tax, and state-transition boundaries;
- stateful invariant tests for accounting, FIFO links, price-level totals, fee reserves, order
  finality, blacklisting, rebases, and solvency recovery;
- gas stress tests for blocked-maker prefixes; and
- repository-wide formatting, compilation, type, and CI checks.

This is a remediation record for the supplied findings, not an independent formal-verification
certificate or a guarantee that no other vulnerabilities exist.

## Findings overview

| ID | Severity | Finding | Status | Resolution |
| --- | --- | --- | --- | --- |
| H-01 | High | Expired-order walls can permanently halt a pair | **Fixed** | Expiry was removed from the limit-order ABI; orders are GTC-only |
| M-01 | Medium | Fee increases can underfund old bid fee reserves and freeze sells | **Fixed** | Fee rate is snapshotted per order and maker/taker fees settle independently |
| M-02 | Medium | A blacklisted maker payout can block FIFO matching | **Fixed** | Failed maker settlement is rolled back; the maker is quarantined and immediately unlinked |
| M-03 | Medium | Negative rebases can make escrow insolvent | **Fixed** | Live solvency gate plus proportional owner cancellation and recovery |
| L-01 | Low | Dust-priced ask can leave a crossed limit buy | **Fixed** | Unfillable or still-crossed incoming remainders are cancelled and refunded instead of resting |
| L-02 | Low | Sender-surcharge tokens can enter escrow but cannot be released | **Fixed** | Funding rejects any transfer that debits the sender by more than the requested amount |
| I-01 | Informational | Per-fill fee flooring allows sub-threshold fills to pay no fee | **Fixed** | Per-order fee carry plus a `0.1` quote-token new-order floor |
| I-02 | Informational | Fragmented fills can pay less quote than one aggregate fill | **Accepted** | Per-fill quote flooring is retained and its maximum loss is property-tested |
| I-03 | Informational | Saturated minimum quantity can still be unfillable | **Fixed** | The lens explicitly reverts when no `uint128` quantity can meet the admission floor |
| I-04 | Informational | Factory NatSpec calls a per-side fee a taker fee | **Fixed** | Both factory interfaces now document the fee as per-side |
| I-05 | Informational | One maximum order can saturate a `uint128` price level | **Fixed** | Price-level aggregates and their view types are `uint256` |

## Detailed findings and remediation

### H-01 — Expired-order wall can permanently halt a pair

**Severity:** High  
**Status:** Fixed

Expired makers were previously removed only during matching. Cleanup consumed the bounded match
steps without filling the taker, and a revert rolled back every removal. A sufficiently large wall
at one price could therefore become impossible to clear within the transaction gas limit.

The selected design removes expiry from the limit-order ABI and stored order model. All accepted
limit orders are good-til-cancelled. Consequently, an expired-order wall cannot be created.

Regression coverage:

- [`testGtcOrderRemainsMatchableAfterTimePasses`](../test/AuditLivenessFindings.t.sol) verifies that
  elapsed time cannot make a resting order unmatchable. Solidity compilation also enforces that
  callers cannot supply expiry through the typed limit-order ABI.

### M-01 — Fee increases can freeze resting bids

**Severity:** Medium  
**Status:** Fixed

A resting bid originally reserved fees at the placement rate but was charged the current market
rate when filled. Raising the market fee could consume or underflow the old reserve and leave the
bid permanently blocking every crossing sell.

Each accepted order now snapshots `feeBps`. A resting maker is charged its captured rate, while a
new taker is charged the rate captured for the incoming order. Buy escrow and fee-reserve release
use the same snapshot, so later administrative fee changes cannot invalidate previously funded
orders.

Regression coverage:

- [`testFeeIncreaseDoesNotBlockRestingBidFromMarketSell`](../test/AuditLivenessFindings.t.sol)
- [`testFeeIncreaseKeepsBestBidFillableForLimitAndMarketSells`](../test/AgnosticProperties.t.sol)
- `testFuzz_FeeIncreaseDoesNotUnderflowRestingBid` in
  [`AgnosticProperties.t.sol`](../test/AgnosticProperties.t.sol)
- the wide-price stateful invariant changes fees while orders rest and independently tracks each
  maker and taker fee.

### M-02 — Blacklisted maker can block FIFO matching

**Severity:** Medium  
**Status:** Fixed

An inline payout to a blacklisted maker could revert the entire taker transaction and leave the
maker at the FIFO head forever. The remediation isolates each fill in an atomic external self-call.
If a recognized maker payout fails, all changes from that fill roll back before the outer matcher:

1. marks the maker order `Quarantined`;
2. immediately unlinks it from the price level with `resting == false`;
3. emits `OrderQuarantined`; and
4. continues matching the next maker within the caller's `maxBookSteps` bound.

The quarantined order retains its escrow claim. Only its owner can call
`closeQuarantinedOrder(orderId, receiver)`, which permits recovery to an alternate receiver. Failed
taker receipts still revert the incoming transaction and do not quarantine an unrelated maker.

Regression and stress coverage:

- [`testM02BlockedMakerIsQuarantinedAndNextMakerFills`](../test/AuditTokenBehaviorFindings.t.sol)
- [`testM02OnlyOwnerCanCloseQuarantineToAlternateReceiver`](../test/AuditTokenBehaviorFindings.t.sol)
- [`testM02FailedTakerPayoutDoesNotQuarantineMakerDuringSelfTrade`](../test/AuditTokenBehaviorFindings.t.sol)
- [`testGasM02HundredBlockedOrdersAreUnlinkedDuringMatching`](../test/AuditTokenBehaviorFindings.t.sol)

The 100-maker stress regression measured approximately 5,928,959 gas to unlink the blocked prefix
and fill the next valid maker. The next match, after those makers had been removed, measured
approximately 325,394 gas. Callers must still select a `maxBookSteps` value large enough for the
prefix they intend to process.

### M-03 — Rebasing token can make escrow insolvent

**Severity:** Medium  
**Status:** Fixed for negative-rebase insolvency  
**Residual limitation:** Positive rebase surplus is not attributed to order owners

A negative rebase can lower the book's token balance between transactions while nominal order
claims remain unchanged. Paying early exits in full would transfer the shortfall to later users.

The remediation tracks `totalEscrowLiability[asset]` across every lock and release. Before any limit
or market order mutates a market, both assets must satisfy:

```text
token.balanceOf(book) >= totalEscrowLiability[asset] + accruedTradingFees[asset]
```

If either asset is short, trading reverts with `MarketInsolvent`. Owner cancellation and
quarantined-order closure remain available. When user escrow itself is undercollateralized, each
order receives a full-precision proportional payout:

```text
nominal order escrow × available assets ÷ total escrow liability
```

The nominal claim is then removed, preserving the recovery ratio for later claimants except for
unavoidable integer rounding. User escrow is senior to accrued protocol fees, and fee withdrawal
is blocked while total liabilities are insolvent. There is no stored pause flag: trading resumes
automatically when balances again cover liabilities.

Regression coverage:

- [`testM03NegativeRebaseBlocksTradingAndCancelsProRata`](../test/AuditTokenBehaviorFindings.t.sol)
- [`testM03ProRataCloseUsesFullPrecision`](../test/AuditTokenBehaviorFindings.t.sol)
- [`testMatrix_BaseAndQuoteRebasesBlockTradingButAllowProRataCancellation`](../test/AdversarialTokenMatrixInvariant.t.sol)
- all stateful accounting handlers compare aggregate liabilities with independently summed trader
  locks.

### L-01 — Dust ask can leave a crossed limit buy

**Severity:** Low  
**Status:** Fixed

When the best maker fill rounds to zero quote, matching stops. The incoming remainder may then rest
at its own price even though it still crosses another order. This can expose a transaction-ordering
attack in which the dust maker is cancelled and the victim's crossed bid is filled at its own
limit.

The remediation centralizes the post-match resting policy: an incoming remainder may rest only if
it has nonzero settlement value at its own price and no longer crosses the best opposite order.
Otherwise it is cancelled, unlinked, and its remaining escrow and fee reserve are returned. A
small taker cannot delete the valid maker that exposed the rounding boundary; only the taker's
unfillable remainder is closed. Resting maker remainders that become dust after a successful fill
are likewise cancelled and refunded.

Regression matrix:

- [`testL01_ZeroQuoteSliceRefundsTakerWithoutRemovingValidMaker`](../test/AuditPricingFindings.t.sol)
  proves that a tiny taker cannot grief valid maker liquidity or leave a crossed order;
- [`testL01_MakerRemainderDustIsRefundedAndUnlinked`](../test/AuditPricingFindings.t.sol) and
  [`testL01_TakerRemainderDustIsRefundedAndUnlinked`](../test/AuditPricingFindings.t.sol) cover both
  sides of partial-fill dust cleanup;
- `testFuzz_ZeroQuoteMakerRemainderIsRefunded` and
  `testFuzz_SettlingSubFloorRemainderStaysMatchable` cover both maker sides across randomized
  remainder sizes, checking that cleanup applies only at zero quote atoms;
- `testFuzz_ZeroQuoteMarketSliceRevertsWithoutChangingMaker` proves that a zero-settlement market
  attempt is atomic on both sides;
- `testFuzz_OneQuoteAtomMarketSliceFillsAndAccountsFeeDust` protects the exact boundary between an
  untradeable fractional quote atom and a valid one-atom fill;
- [`testL01_ExactMinimumNotionalBoundaryFillsNormally`](../test/AuditPricingFindings.t.sol) protects
  the exact `0.1` quote-token admission boundary; and
- [`testL01_ZeroQuoteRefundIncludesFeeReserve`](../test/AuditPricingFindings.t.sol) verifies complete
  escrow and fee-reserve recovery without charging a fee.

The wide-price stateful invariant additionally requires every linked remainder to have nonzero
quote value and requires the resting best bid to remain strictly below the best ask.

### L-02 — Sender-surcharge tokens can lock escrow

**Severity:** Low  
**Status:** Fixed for behavior observable during funding

A token may credit the requested amount to the book while debiting the sender by an additional
surcharge. That pull passes recipient-delta validation, but a later push also surcharges the book
and is rejected by the exact contract-debit check. Settlement or cancellation can therefore fail.

The funding seam now measures both sides of the real `transferFrom`: the book balance determines
the accepted quantity, while the trader balance must decrease by exactly the requested amount. A
larger or smaller sender debit reverts the complete transaction before an order or escrow liability
is created. This preserves support for recipient-tax tokens, where the sender still loses exactly
the requested amount but the book receives less.

Regression coverage:

- [`testL02SenderSurchargeIsRejectedBeforeEscrow`](../test/AuditTokenBehaviorFindings.t.sol) checks
  atomic rejection, zero liability, and unchanged trader and book balances;
- [`testL02SenderSurchargeMarketTakerCannotGriefMaker`](../test/AuditTokenBehaviorFindings.t.sol)
  verifies that rejected wallet funding cannot mutate a resting maker; and
- [`testNormalTokenFundingPreservesRequestedQuantity`](../test/SpotCLOBAdversarial.t.sol),
  [`testStandardEntryPointUsesFeeOnTransferBalanceDelta`](../test/SpotCLOBAdversarial.t.sol), and the
  1% through 99% funding fuzz campaign protect normal and recipient-tax compatibility.

The outgoing exact-debit check remains a second safety boundary. A token that changes its accounting
after funding, or behaves differently specifically when the book is the sender, remains an
unsupported mutable-token behavior because ERC-20 exposes no reliable on-chain preflight interface.

### I-01 — Per-fill fee flooring

**Severity:** Informational  
**Status:** Fixed

Each order now carries its fractional BPS fee numerator across fills. Once the accumulated
remainder reaches the 10,000 BPS denominator, one quote-token atom is charged. Splitting one order
across many fills therefore produces the same maker fee and proceeds as filling that order once.
Resting bid reserves preview the carried remainder, so accumulating a fee cannot underfund or
freeze the bid.

New supply-agnostic limit orders must also be worth at least one tenth of a quote token at their
limit price. For six-decimal USDC this is `100,000` atoms (`0.1 USDC`). The check runs before
funding and again after recipient-side transfer tax adjusts the accepted quantity, so a taxed order
cannot enter below the floor. The lens reports the corresponding minimum base quantity for each
price. Legacy markets retain their historical one-atom floor.

This is intentionally an admission rule, not a minimum fill size. A valid order may be partially
filled below `0.1` quote token and continue matching. If its remaining quantity has zero quote-atom
settlement value, the existing L-01 cleanup unlinks it and returns its actual escrow. A theoretical
fraction of an ERC-20 atom is never held and therefore cannot be transferred or refunded.

The accumulator is deliberately order-local. A completed or cancelled order can retain a final
fraction smaller than one quote atom, and separate orders do not share that fraction. A
trader-wide accumulator was rejected because unrelated orders could replenish the accumulator and
make an older resting bid's finite fee reserve insufficient.

Regression coverage:

- `testI01_MakerOrderCarriesFeeAcrossSplitFills`;
- `testI01_TakerOrderCarriesFeeAcrossMultipleMakers`;
- `testI01_SubAtomFeeCarriesAcrossFillsOfSameOrder`;
- `testI01_CarriedFeeDoesNotUnderfundRestingBid`; and
- `testFuzz_I01MakerFeeIsInvariantToFillPartition` in
  [`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol);
- `testFuzz_FeeCarryIsPartitionInvariantOnBothSides` covers buy and sell makers, randomized
  two-to-eight-part fills, final sub-atom fee remainders, escrow release, and wallet settlement;
- `testMinimumNewOrderNotionalIsOneTenthUsdc`; and
- `testAgnosticFeeOnTransferCannotReduceOrderBelowAdmissionFloor`.

The wide-price stateful invariant independently models each order's fee remainder and verifies it
against the contract after mixed placement, matching, fee-update, cancellation, and withdrawal
actions. It also injects sub-minimum buy and sell placements, requires atomic rejection without
token or book changes, and rejects any observed increase in filled base quantity without a
corresponding positive quote fill.

### I-02 — Fragmented quote rounding

**Severity:** Informational  
**Status:** Accepted

Quote is rounded down per fill without carrying a per-order remainder. A maker filled in many
pieces can receive slightly less than if the same quantity were filled once. The discrepancy is
less than one quote atom per fill. This branch intentionally retains that simple, deterministic
settlement rule instead of adding quote-remainder state solely to recover fractional token atoms.

Coverage includes the concrete `testAccepted_I02_ManyPartialFillsPayLessQuoteThanOneFill`
regression in [`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol), plus
`testFuzz_QuoteRoundingAcrossDecimals` and `testFuzz_QuoteSettlementZeroAndOneAtomBoundaries` in
[`SpotPriceMath.t.sol`](../test/SpotPriceMath.t.sol). The fuzz properties exercise up to 16
partitions across every supported decimal exponent, prove that settlement never rounds up, and
bound fragmentation loss below the partition count.

### I-03 — Saturated minimum quantity is unfillable

**Severity:** Informational  
**Status:** Fixed

When the mathematical minimum quantity exceeds `uint128`, `minimumBaseQuantity` saturates at
`type(uint128).max`. At the affected decimal and price relationship, even that value settles zero
quote and cannot be placed. The lens now checks this condition and reverts with
`MinimumQuantityUnrepresentable(price)` instead of presenting a value that looks actionable.

Coverage: `testI03_UnrepresentableMinimumRevertsExplicitly` in
[`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol).

### I-04 — Trading-fee NatSpec is inaccurate

**Severity:** Informational  
**Status:** Fixed

The `createPairWithFee` NatSpec in [`ISpotCLOBFactory`](../src/ISpotCLOBFactory.sol) and
[`SpotCLOBFactory`](../src/SpotCLOBFactory.sol) previously called `tradingFeeBps` a taker fee, while
settlement charges the configured rate to both maker and taker. Both comments now describe it as a
per-side trading fee.

### I-05 — Price-level quantity saturation

**Severity:** Informational  
**Status:** Fixed

`PriceLevel.totalQuantity` was `uint128`, so one maximum-size order saturated the aggregate and
prevented another order from resting at that exact price. The aggregate and all corresponding view
quantities are now `uint256`; individual orders remain bounded by `uint128`.

Coverage: `testI05_MaxQuantityDoesNotSaturatePriceLevel` in
[`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol) and the 256-case
`testFuzz_PriceLevelAggregateExceedsUint128` property in
[`ArithmeticBounds.t.sol`](../test/ArithmeticBounds.t.sol).

## Additional hardening completed

### Recipient-tax token support

Limit-order funding now measures the book's balance delta and derives the maximum quantity funded
by the amount actually received. This behavior applies through the standard limit-order entry
points; a separate fee-token function is not required.

- Sell quantity is reduced to the number of complete lots or raw base atoms received.
- Buy quantity is reduced to the maximum amount covered by received quote plus its snapshotted fee
  reserve.
- Funding also requires the trader's balance to decrease by exactly the requested transfer amount,
  rejecting sender surcharges without rejecting recipient-side transfer taxes.
- `OrderPlaced` reports accepted quantity, and `OrderQuantityAdjusted` reports requested and
  accepted quantities when they differ.
- Settlement measures the recipient's actual balance increase, so market-order `minReceive` checks
  net output after recipient tax.
- Wallet-funded market inputs remain exact-transfer-only to prevent short transfers from consuming
  pooled maker escrow.

Coverage is provided by [`SpotCLOBAdversarial.t.sol`](../test/SpotCLOBAdversarial.t.sol), including
a 256-case funding fuzz test across 1% through 99% transfer tax.

### Mixed adversarial token invariant

[`AdversarialTokenMatrixInvariant.t.sol`](../test/AdversarialTokenMatrixInvariant.t.sol) combines
behaviors that were previously tested only in isolation:

| Dimension | Values exercised |
| --- | --- |
| Token pull behavior | Standard transfer and recipient tax |
| Token push behavior | Standard transfer, recipient tax, and receiver blacklist |
| Exchange fees | Fee updates and different maker/taker snapshots |
| Order lifecycle | Create, partial/full fill, cancel, quarantine, alternate-receiver close |
| Solvency | Base rebase, quote rebase, failed trade probe, proportional close, recapitalization |
| Roles | Buy and sell makers/takers across four independent traders |

The invariant asserts aggregate liability equality, monotonic and bounded fills, terminal-order
finality, quarantine isolation, FIFO predecessor links, price-level totals, and price-tree bitmap
membership. Expected external-token failures are contained inside the handler, allowing the
campaign to require zero handler reverts.

## Latest gas benchmark

The benchmark snapshot was captured on 12 October 2026 from code revision `fe824dd` with Solidity
0.8.24, optimizer enabled for 200 runs, and Foundry 1.7.1. Fixture seeding is excluded from the
measured operation. These are local EVM gas deltas, not deployed transaction receipts.

```sh
forge test --match-contract '.*BenchmarkTest' -vv
```

The benchmark campaign completed 22 cases with no failures; two large synthetic-book cases remain
intentionally skipped. Key order-action results:

| Action | Book before | Levels before | Matches | Gas | Gas per match |
| --- | ---: | ---: | ---: | ---: | ---: |
| Create limit at new level | 0 | 0 | 0 | 775,252 | — |
| Create limit at existing level | 1 | 1 | 0 | 201,044 | — |
| Cancel one resting order | 1 | 1 | 0 | 52,622 | — |
| Fill one resting order with a limit order | 1 | 1 | 1 | 503,624 | 503,624 |
| Market fill 100 orders at one level | 100 | 1 | 100 | 9,952,244 | 99,522 |
| Market fill 50 orders in a 1,000-level book | 2,000 | 1,000 | 50 | 5,417,105 | 108,342 |
| Market fill 100 orders in a 1,000-level book | 2,000 | 1,000 | 100 | 10,541,542 | 105,415 |
| Market fill 200 orders in a 1,000-level book | 2,000 | 1,000 | 200 | 20,782,135 | 103,910 |

The complete transaction-style and direct-call tables are maintained in
[`contracts/README.md`](../README.md). The repository-level table also includes illustrative MON
and USD conversions in [`README.md`](../../README.md).

## Verification evidence

The branch is configured with:

```text
FOUNDRY_INVARIANT_RUNS=10
FOUNDRY_INVARIANT_DEPTH=64
```

The latest verified run completed:

- **197 passed, 0 failed, 2 intentionally skipped**;
- three stateful invariant campaigns, each at 10 runs × 64 calls with zero handler reverts;
- repository checks for contracts, indexer, and web; and
- automated PR reporting from the `github-actions` bot.

The continuously updated test table and invariant results are available in the
[Forge verification comment](https://github.com/saurabhburade/onchain-spot-orderbook/pull/2#issuecomment-6085539906).
The recorded 197-test result comes from
[GitHub Actions run 38285571890](https://github.com/saurabhburade/onchain-spot-orderbook/actions/runs/38285571890),
which passed against code revision `fe824dd` on 12 October 2026.

Useful local commands:

```sh
cd contracts
FOUNDRY_INVARIANT_RUNS=10 FOUNDRY_INVARIANT_DEPTH=64 forge test
forge fmt --check
```

From the repository root:

```sh
pnpm check
```

## Deployment and residual-risk notes

- Existing pair contracts are non-upgradeable clones. H-01, M-01, M-02, M-03, L-01, I-01, and the
  transfer-tax changes require a new implementation/factory deployment and migration; merging this
  branch does not change already deployed books.
- The optimized `SpotCLOB` runtime is 31,041 bytes. It fits Monad's documented 128 KiB runtime
  allowance but exceeds Ethereum's 24 KiB EIP-170 limit and is not portable to such chains without
  modularization.
- Limit orders are GTC-only and the order ABI has no expiry field.
- Positive rebase surplus is not distributed to order owners.
- Direction-dependent fees, reflection/reward, and malicious mutable-token accounting remain
  unsupported.
- I-02's accepted per-fill quote-flooring behavior should remain visible in integration
  documentation.
