// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { AgnosticToken } from "./AgnosticPricing.t.sol";
import { PropertyVm } from "./AgnosticProperties.t.sol";

/// @notice Exercises the wide-price path with actual fees and independently tracked liabilities.
/// @dev Fees change while orders rest. Unexpected reverts fail the handler instead of being
/// swallowed, so a stale bid reserve cannot silently block matching.
contract AgnosticInvariantHandler {
    PropertyVm private constant vm =
        PropertyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint16 private constant INITIAL_FEE_BPS = 37;
    uint256 private constant INITIAL = 1e60;
    address private constant OUTSIDER = address(0xBAD);

    SpotCLOB public immutable book;
    SpotCLOBFactory public immutable factory;
    AgnosticToken public immutable base;
    AgnosticToken public immutable quote;
    bytes32 private immutable poolId;
    address[3] private traders = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint128[8] private prices =
        [uint128(1e7), 1e12, 1e18, 1e18 + 1, 1 << 64, 1e24, 1 << 96, type(uint128).max];
    bytes32[] private orderIds;
    mapping(bytes32 id => uint128 filled) private priorFilled;
    mapping(bytes32 id => uint256 quoteFilled) private priorQuoteFilled;
    mapping(bytes32 id => ISpotCLOB.OrderStatus status) private priorStatus;
    mapping(bytes32 id => uint256 amount) private feeReserves;
    mapping(bytes32 id => uint16 feeBps) private orderFeeBps;
    uint16 private currentFeeBps = INITIAL_FEE_BPS;
    uint256 private expectedFees;

    uint256 public placements;
    uint256 public marketFills;
    uint256 public cancellations;
    uint256 public timeAdvances;
    uint256 public withdrawals;
    uint256 public feeUpdates;

    constructor() {
        factory = new SpotCLOBFactory();
        base = new AgnosticToken(18);
        quote = new AgnosticToken(6);
        factory.setQuoteToken(address(quote), true);
        address deployed;
        (poolId, deployed) =
            factory.createPairWithFee(address(base), address(quote), INITIAL_FEE_BPS);
        book = SpotCLOB(deployed);
        for (uint256 i; i < traders.length; ++i) {
            base.mint(traders[i], INITIAL);
            quote.mint(traders[i], INITIAL);
            vm.prank(traders[i]);
            base.approve(address(book), type(uint256).max);
            vm.prank(traders[i]);
            quote.approve(address(book), type(uint256).max);
        }
    }

    function act(uint256 seed) external {
        uint256 operation = uint8(seed) % 9;
        bytes32 newId;
        if (operation <= 1) {
            newId = _place(seed, operation == 0 ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell);
        } else if (operation <= 3) {
            newId = _market(seed, operation == 2 ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell);
        } else if (operation == 4) {
            _cancel(seed, false);
        } else if (operation == 5) {
            _cancel(seed, true);
        } else if (operation == 6) {
            vm.warp(block.timestamp + 1 + (seed >> 8) % 8);
            ++timeAdvances;
        } else if (operation == 7) {
            uint256 accrued = book.accruedTradingFees(address(quote));
            if (accrued != 0) {
                uint256 amount = 1 + (seed >> 8) % accrued;
                book.withdrawTradingFees(address(quote), address(this), amount);
                expectedFees -= amount;
                ++withdrawals;
            }
        } else {
            currentFeeBps = uint16((seed >> 8) % 1_001);
            factory.setPairTradingFeeBps(address(base), address(quote), currentFeeBps);
            ++feeUpdates;
        }
        _observeExistingOrders();
        if (newId != bytes32(0)) _trackNewOrder(newId);
    }

    function assertAccounting() external view {
        uint256 baseWallets = base.balanceOf(address(this));
        uint256 quoteWallets = quote.balanceOf(address(this));
        uint256 totalBaseLocked;
        uint256 totalQuoteLocked;
        for (uint256 i; i < traders.length; ++i) {
            uint256 expectedBaseLocked;
            uint256 expectedQuoteLocked;
            for (uint256 j; j < orderIds.length; ++j) {
                (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
                    book.getOrder(orderIds[j]);
                (,, bool resting) = book.getOrderLinks(orderIds[j]);
                if (order.trader != traders[i] || !resting) continue;
                uint128 remaining = state.quantity - state.filledQuantity;
                if (order.side == ISpotCLOB.Side.Sell) {
                    expectedBaseLocked += remaining;
                } else {
                    expectedQuoteLocked += _quote(order.price, remaining) + feeReserves[orderIds[j]];
                }
            }
            (, uint256 lockedBase,) = book.balanceOf(traders[i], address(base));
            (, uint256 lockedQuote,) = book.balanceOf(traders[i], address(quote));
            require(lockedBase == expectedBaseLocked, "base escrow differs from remaining orders");
            require(
                lockedQuote == expectedQuoteLocked, "quote escrow differs from remaining orders"
            );
            totalBaseLocked += lockedBase;
            totalQuoteLocked += lockedQuote;
            baseWallets += base.balanceOf(traders[i]);
            quoteWallets += quote.balanceOf(traders[i]);
        }
        require(book.accruedTradingFees(address(quote)) == expectedFees, "ghost fee mismatch");
        require(book.accruedTradingFees(address(base)) == 0, "base fees accrued");
        require(
            book.totalEscrowLiability(address(base)) == totalBaseLocked,
            "aggregate base escrow mismatch"
        );
        require(
            book.totalEscrowLiability(address(quote)) == totalQuoteLocked,
            "aggregate quote escrow mismatch"
        );
        require(base.balanceOf(address(book)) == totalBaseLocked, "base liabilities insolvent");
        require(
            quote.balanceOf(address(book)) == totalQuoteLocked + expectedFees,
            "quote liabilities insolvent"
        );
        require(baseWallets + base.balanceOf(address(book)) == INITIAL * 3, "base supply changed");
        require(
            quoteWallets + quote.balanceOf(address(book)) == INITIAL * 3, "quote supply changed"
        );
    }

    function assertBook() external view {
        for (uint256 p; p < prices.length; ++p) {
            _assertLevel(prices[p], ISpotCLOB.Side.Buy);
            _assertLevel(prices[p], ISpotCLOB.Side.Sell);
        }
        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            book.getOrderBook(poolId, 256);
        uint256 bidIndex;
        uint256 askIndex;
        for (uint256 p; p < prices.length; ++p) {
            (uint128 levelBidQuantity,,) =
                book.getPriceLevel(poolId, ISpotCLOB.Side.Buy, prices[prices.length - 1 - p]);
            (uint128 levelAskQuantity,,) =
                book.getPriceLevel(poolId, ISpotCLOB.Side.Sell, prices[p]);
            if (levelBidQuantity != 0) {
                require(bidIndex < bids.length, "missing bid level");
                require(
                    bids[bidIndex].price == prices[prices.length - 1 - p]
                        && bids[bidIndex].quantity == levelBidQuantity,
                    "bid traversal mismatch"
                );
                ++bidIndex;
            }
            if (levelAskQuantity != 0) {
                require(askIndex < asks.length, "missing ask level");
                require(
                    asks[askIndex].price == prices[p]
                        && asks[askIndex].quantity == levelAskQuantity,
                    "ask traversal mismatch"
                );
                ++askIndex;
            }
        }
        require(bidIndex == bids.length && askIndex == asks.length, "unexpected price level");
        (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        ) = book.getBestPrices(poolId);
        require(
            bidExists == (bids.length != 0) && askExists == (asks.length != 0),
            "best-price existence mismatch"
        );
        if (bidExists) {
            require(
                bidPrice == bids[0].price && bidQuantity == bids[0].quantity, "best bid mismatch"
            );
        }
        if (askExists) {
            require(
                askPrice == asks[0].price && askQuantity == asks[0].quantity, "best ask mismatch"
            );
        }
    }

    function _place(uint256 seed, ISpotCLOB.Side side) private returns (bytes32) {
        uint128 price = prices[(seed >> 8) % prices.length];
        uint128 minimum = uint128((1e30 + uint256(price) - 1) / price);
        // Mix near-atom quantities with sizes that generate nonzero fees at all price magnitudes.
        uint128 multiplier = (seed >> 24) & 1 == 0 ? 1 : 10_000;
        uint128 quantity = minimum * uint128(1 + (seed >> 16) % 4) * multiplier;
        address trader = traders[(seed >> 32) % traders.length];
        ISpotCLOB.LimitOrder memory order = ISpotCLOB.LimitOrder({
            trader: trader,
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: side,
            price: price,
            quantity: quantity,
            expiry: 0,
            clientOrderId: 0
        });
        vm.prank(trader);
        bytes32 id = book.placeLimitOrderWithMaxBookSteps(order, 1_024);
        ++placements;
        return id;
    }

    function _market(uint256 seed, ISpotCLOB.Side side) private returns (bytes32) {
        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            book.getOrderBook(poolId, 1);
        ISpotCLOB.PriceLevelView[] memory makers = side == ISpotCLOB.Side.Buy ? asks : bids;
        uint128 quantity = 1;
        if (makers.length != 0) {
            uint128 minimum = uint128((1e30 + uint256(makers[0].price) - 1) / makers[0].price);
            quantity = (seed >> 16) & 1 == 0 ? minimum : makers[0].quantity + minimum;
        }
        address trader = traders[(seed >> 32) % traders.length];
        ISpotCLOB.MarketOrder memory order = ISpotCLOB.MarketOrder({
            trader: trader,
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: side,
            quantity: quantity,
            priceLimit: 0,
            minFillQuantity: 0,
            minReceive: 0,
            clientOrderId: 0
        });
        vm.prank(trader);
        (bool success, bytes memory result) =
            address(book).call(abi.encodeCall(SpotCLOB.executeMarketOrder, (order, uint32(1_024))));
        if (!success) {
            require(
                keccak256(result)
                    == keccak256(abi.encodeWithSelector(SpotCLOB.NoLiquidity.selector)),
                "unexpected market revert"
            );
            return bytes32(0);
        }
        ++marketFills;
        return abi.decode(result, (bytes32));
    }

    function _cancel(uint256 seed, bool unauthorized) private {
        if (orderIds.length == 0) return;
        bytes32 id = orderIds[(seed >> 8) % orderIds.length];
        (ISpotCLOB.LimitOrder memory order,) = book.getOrder(id);
        if (unauthorized) {
            vm.prank(OUTSIDER);
            (bool success, bytes memory reason) =
                address(book).call(abi.encodeCall(SpotCLOB.cancelOrder, (id)));
            require(
                !success
                    && keccak256(reason)
                        == keccak256(abi.encodeWithSelector(SpotCLOB.Unauthorized.selector)),
                "outsider cancellation accepted"
            );
        } else {
            (,, bool resting) = book.getOrderLinks(id);
            if (!resting) return;
            vm.prank(order.trader);
            book.cancelOrder(id);
            ++cancellations;
        }
    }

    function _observeExistingOrders() private {
        for (uint256 i; i < orderIds.length; ++i) {
            bytes32 id = orderIds[i];
            (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
                book.getOrder(id);
            require(
                state.filledQuantity >= priorFilled[id] && state.filledQuantity <= state.quantity,
                "fill is not monotonic and bounded"
            );
            require(state.filledQuoteQuantity >= priorQuoteFilled[id], "quote fill decreased");
            if (
                priorStatus[id] == ISpotCLOB.OrderStatus.Filled
                    || priorStatus[id] == ISpotCLOB.OrderStatus.Cancelled
            ) {
                require(
                    state.status == priorStatus[id] && state.filledQuantity == priorFilled[id],
                    "closed order resurrected"
                );
            }
            // Each existing maker can fill at most once per incoming order. Count maker deltas
            // only, so the incoming taker's cumulative quote does not double-count or hide
            // rounding.
            uint256 quoteDelta = state.filledQuoteQuantity - priorQuoteFilled[id];
            uint256 makerFee = quoteDelta * orderFeeBps[id] / 10_000;
            uint256 takerFee = quoteDelta * currentFeeBps / 10_000;
            expectedFees += makerFee + takerFee;
            if (order.side == ISpotCLOB.Side.Buy) feeReserves[id] -= makerFee;
            (,, bool resting) = book.getOrderLinks(id);
            if (!resting) feeReserves[id] = 0;
            _remember(id, state);
        }
    }

    function _trackNewOrder(bytes32 id) private {
        for (uint256 i; i < orderIds.length; ++i) {
            require(orderIds[i] != id, "duplicate order id");
        }
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) = book.getOrder(id);
        orderFeeBps[id] = currentFeeBps;
        (,, bool resting) = book.getOrderLinks(id);
        if (resting && order.side == ISpotCLOB.Side.Buy) {
            feeReserves[id] =
                _quote(order.price, state.quantity - state.filledQuantity) * currentFeeBps / 10_000;
        }
        _remember(id, state);
        orderIds.push(id);
    }

    function _remember(bytes32 id, ISpotCLOB.OrderState memory state) private {
        priorFilled[id] = state.filledQuantity;
        priorQuoteFilled[id] = state.filledQuoteQuantity;
        priorStatus[id] = state.status;
    }

    function _assertLevel(uint128 price, ISpotCLOB.Side side) private view {
        uint128 expectedQuantity;
        bytes32 first;
        bytes32 last;
        for (uint256 i; i < orderIds.length; ++i) {
            (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
                book.getOrder(orderIds[i]);
            (bytes32 previous, bytes32 next, bool resting) = book.getOrderLinks(orderIds[i]);
            if (state.status == ISpotCLOB.OrderStatus.Filled) {
                require(state.filledQuantity == state.quantity, "filled order has remainder");
            }
            if (
                state.kind == ISpotCLOB.OrderKind.Market
                    || state.status == ISpotCLOB.OrderStatus.Cancelled
                    || state.status == ISpotCLOB.OrderStatus.Filled
            ) {
                require(
                    !resting && previous == bytes32(0) && next == bytes32(0),
                    "closed or market order linked"
                );
            }
            if (!resting || order.price != price || order.side != side) continue;
            require(
                state.kind == ISpotCLOB.OrderKind.Limit && state.filledQuantity < state.quantity,
                "invalid resting order"
            );
            require(previous == last, "FIFO predecessor mismatch");
            if (last != bytes32(0)) {
                (, bytes32 previousNext,) = book.getOrderLinks(last);
                require(previousNext == orderIds[i], "FIFO successor mismatch");
            } else {
                first = orderIds[i];
            }
            last = orderIds[i];
            expectedQuantity += state.quantity - state.filledQuantity;
        }
        (uint128 quantity, bytes32 head, bytes32 tail) = book.getPriceLevel(poolId, side, price);
        require(
            quantity == expectedQuantity && head == first && tail == last,
            "level differs from order model"
        );
        require(
            book.isPriceLevelActive(poolId, side, price) == (expectedQuantity != 0),
            "radix membership mismatch"
        );
        if (last != bytes32(0)) {
            (, bytes32 next,) = book.getOrderLinks(last);
            require(next == bytes32(0), "FIFO tail has successor");
        }
    }

    function _quote(uint128 price, uint128 quantity) private pure returns (uint256) {
        return uint256(price) * quantity / 1e30;
    }
}

contract AgnosticInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    AgnosticInvariantHandler private handler;

    function setUp() public {
        handler = new AgnosticInvariantHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        targets = new FuzzSelector[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = AgnosticInvariantHandler.act.selector;
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariant_WidePriceAccountingFeesAndFIFO() public view {
        handler.assertAccounting();
        handler.assertBook();
    }

    function testFuzz_MixedWidePriceTransitions(uint256 seed) public {
        for (uint256 i; i < 32; ++i) {
            handler.act(uint256(keccak256(abi.encode(seed, i))));
            handler.assertAccounting();
            handler.assertBook();
        }
    }

    function testHandlerExercisesFeesMarketsCancellationAndTime() public {
        handler.act(1 | (2 << 8) | (1 << 24)); // A funded ask that generates fees.
        handler.act(2 | (1 << 16) | (1 << 32)); // Market buy with an unfilled remainder.
        handler.act(7); // Withdraw one quote atom of the accrued fees.
        handler.act(0 | (2 << 8) | (1 << 24) | (1 << 32));
        handler.act(8 | (900 << 8)); // Raise the fee while the bid is resting.
        handler.act(3 | (1 << 16)); // Market sell into the funded bid.
        handler.act(1 | (4 << 8) | (1 << 24)); // GTC wide-price ask.
        handler.act(5 | (4 << 8)); // Unauthorized cancellation must revert.
        handler.act(6); // Advance time; the GTC ask remains open.
        handler.act(4 | (4 << 8)); // Its owner can cancel and recover escrow.
        handler.assertAccounting();
        handler.assertBook();
        require(handler.placements() == 3 && handler.marketFills() == 2, "trades not exercised");
        require(
            handler.withdrawals() == 1 && handler.cancellations() == 1,
            "escrow actions not exercised"
        );
        require(handler.timeAdvances() == 1, "time advance not exercised");
        require(handler.feeUpdates() == 1, "fee update not exercised");
    }

    function testRegression_ZeroEscrowDustCleanupDoesNotQuarantine() public {
        handler.act(9993);
        handler.act(2563991712433960642540854971761029811582818741952848999397942);
        handler.act(132111622194633123064977512839933);
        handler.act(1_000_000_000);
        handler.act(10_908);
        handler.assertAccounting();
        handler.assertBook();
    }
}
