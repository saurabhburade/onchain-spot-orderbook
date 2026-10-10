# Initial Smart Contract Audit and Remediation Report

## Report metadata

| Field | Value |
| --- | --- |
| Project | Onchain Spot Orderbook |
| Component | `SpotCLOB`, factory, pricing libraries, and Solidity test suite |
| Original reviewer | [@0x3b33](https://github.com/0x3b33) |
| Remediation branch | [`initial-audit-invariant`](https://github.com/saurabhburade/onchain-spot-orderbook/tree/initial-audit-invariant) |
| Remediation PR | [#2 — Initial audit invariants and liveness fixes](https://github.com/saurabhburade/onchain-spot-orderbook/pull/2) |
| Report date | 10 October 2026 |
| Solidity version | 0.8.24 |

## Executive summary

The initial review reported eleven findings: one high-severity, three medium-severity, two
low-severity, and five informational findings. This branch fixes the high-severity finding and all
three medium-severity findings. The two low-severity and five informational findings remain open
or explicitly acknowledged, with regression tests preserving each known behavior.

The remediation also adds support for conventional recipient-tax tokens, aggregate escrow
liability accounting, adversarial token-behavior tests, and three stateful invariant campaigns.

| Severity | Reported | Fixed | Open or acknowledged |
| --- | ---: | ---: | ---: |
| High | 1 | 1 | 0 |
| Medium | 3 | 3 | 0 |
| Low | 2 | 0 | 2 |
| Informational | 5 | 0 | 5 |
| **Total** | **11** | **4** | **7** |

### Status definitions

- **Fixed** — runtime remediation is implemented and covered by a regression test.
- **Acknowledged** — the behavior is deliberately unsupported or accepted and is documented and
  reproduced by a test.
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
| L-01 | Low | Dust-priced ask can leave a crossed limit buy | **Open** | Reproduced by a regression test; crossed remainder handling still needs correction |
| L-02 | Low | Sender-surcharge tokens can enter escrow but cannot be released | **Acknowledged** | Token model remains unsupported and documented; behavior is reproduced by a test |
| I-01 | Informational | Per-fill fee flooring allows sub-threshold fills to pay no fee | **Open** | Reproduced; cumulative fee accounting is not implemented |
| I-02 | Informational | Fragmented fills can pay less quote than one aggregate fill | **Open** | Reproduced; cumulative quote-remainder accounting is not implemented |
| I-03 | Informational | Saturated minimum quantity can still be unfillable | **Open** | Reproduced; the lens still returns `type(uint128).max` |
| I-04 | Informational | Factory NatSpec calls a per-side fee a taker fee | **Open** | The affected NatSpec still requires correction |
| I-05 | Informational | One maximum order can saturate a `uint128` price level | **Open** | Reproduced; the level aggregate remains `uint128` |

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
**Status:** Open

When the best maker fill rounds to zero quote, matching stops. The incoming remainder may then rest
at its own price even though it still crosses another order. This can expose a transaction-ordering
attack in which the dust maker is cancelled and the victim's crossed bid is filled at its own
limit.

The behavior remains intentionally visible in
[`testKnownIssue_L01_DustBestAskLeavesCrossedBuyAfterCancellation`](../test/AuditPricingFindings.t.sol).
The recommended future correction is to cancel and release an incoming remainder whenever it still
crosses the opposite book after matching stops.

### L-02 — Sender-surcharge tokens can lock escrow

**Severity:** Low  
**Status:** Acknowledged as unsupported

A token may credit the requested amount to the book while debiting the sender by an additional
surcharge. That pull passes recipient-delta validation, but a later push also surcharges the book
and is rejected by the exact contract-debit check. Settlement or cancellation can therefore fail.

Sender-surcharge, reflection/reward, and otherwise mutable or malicious token accounting are
explicitly unsupported. The known behavior is preserved by
[`testKnownIssue_L02SenderSurchargeBreaksPushValidation`](../test/AuditTokenBehaviorFindings.t.sol).
If these tokens must be rejected at funding time, the pull boundary should additionally validate
the sender's balance delta.

### I-01 — Per-fill fee flooring

**Severity:** Informational  
**Status:** Open

Fees are rounded down independently for every fill. Splitting volume into sub-threshold fills can
therefore reduce the aggregate fee, although the loss is less than one quote atom per side per fill
and the transaction cost makes deliberate exploitation uneconomic in the tested environment.

Coverage: `testKnownIssue_I01_SplittingSubThresholdFillsReducesFees` in
[`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol).

### I-02 — Fragmented quote rounding

**Severity:** Informational  
**Status:** Open

Quote is rounded down per fill without carrying a per-order remainder. A maker filled in many
pieces can receive slightly less than if the same quantity were filled once. The discrepancy is
less than one quote atom per fill.

Coverage: `testKnownIssue_I02_ManyPartialFillsPayLessQuoteThanOneFill` in
[`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol).

### I-03 — Saturated minimum quantity is unfillable

**Severity:** Informational  
**Status:** Open

When the mathematical minimum quantity exceeds `uint128`, `minimumBaseQuantity` returns
`type(uint128).max`. At the affected decimal and price relationship, even that value settles zero
quote and cannot be placed. The lens therefore presents a value that looks actionable but is not.

Coverage: `testKnownIssue_I03_SaturatedMinimumQuantityCannotSettle` in
[`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol).

### I-04 — Trading-fee NatSpec is inaccurate

**Severity:** Informational  
**Status:** Open

The `createPairWithFee` NatSpec in [`ISpotCLOBFactory`](../src/ISpotCLOBFactory.sol) and
[`SpotCLOBFactory`](../src/SpotCLOBFactory.sol) calls `tradingFeeBps` a taker fee, while settlement
charges the configured per-side rate to both maker and taker. The documentation should describe it
as a per-side trading fee.

### I-05 — Price-level quantity saturation

**Severity:** Informational  
**Status:** Open

`PriceLevel.totalQuantity` is `uint128`, so one maximum-size order saturates the aggregate and
prevents another order from resting at that exact price. Adjacent prices remain usable, and the
attack requires funding the full maximum quantity at the chosen price.

Coverage: `testKnownIssue_I05_MaxQuantitySaturatesPriceLevel` in
[`AuditPricingFindings.t.sol`](../test/AuditPricingFindings.t.sol).

## Additional hardening completed

### Recipient-tax token support

Limit-order funding now measures the book's balance delta and derives the maximum quantity funded
by the amount actually received. This behavior applies through the standard limit-order entry
points; a separate fee-token function is not required.

- Sell quantity is reduced to the number of complete lots or raw base atoms received.
- Buy quantity is reduced to the maximum amount covered by received quote plus its snapshotted fee
  reserve.
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

## Verification evidence

The branch is configured with:

```text
FOUNDRY_INVARIANT_RUNS=10
FOUNDRY_INVARIANT_DEPTH=64
```

The latest verified run completed:

- **180 passed, 0 failed, 2 intentionally skipped**;
- three stateful invariant campaigns, each at 10 runs × 64 calls with zero handler reverts;
- repository checks for contracts, indexer, and web; and
- automated PR reporting from the `github-actions` bot.

The continuously updated test table and invariant results are available in the
[Forge verification comment](https://github.com/saurabhburade/onchain-spot-orderbook/pull/2#issuecomment-6085539906).

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

- Existing pair contracts are non-upgradeable clones. H-01, M-01, M-02, M-03, and the transfer-tax
  changes require a new implementation/factory deployment and migration; merging this branch does
  not change already deployed books.
- The optimized `SpotCLOB` runtime is 30,535 bytes. It fits Monad's documented 128 KiB runtime
  allowance but exceeds Ethereum's 24 KiB EIP-170 limit and is not portable to such chains without
  modularization.
- Limit orders are GTC-only and the order ABI has no expiry field.
- Positive rebase surplus is not distributed to order owners.
- Sender-surcharge, reflection/reward, and malicious token accounting remain unsupported.
- Open low and informational findings should remain visible in release notes and integration
  documentation until they are fixed.

## Conclusion

The branch removes the reported high-severity liveness failure and fixes all three medium-severity
findings with explicit regression and invariant coverage. Remaining findings are lower-severity
rounding, representability, documentation, or unsupported-token concerns. They are not silently
suppressed: each executable behavior is reproduced by a named test, and the mixed adversarial
invariant continuously checks their interaction with the remediated accounting and matching paths.
