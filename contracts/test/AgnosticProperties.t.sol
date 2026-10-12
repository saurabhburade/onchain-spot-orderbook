// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { AgnosticToken } from "./AgnosticPricing.t.sol";

interface PropertyVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata reason) external;
    function expectRevert(bytes4 selector) external;
}

contract AgnosticPropertiesTest {
    PropertyVm private constant vm =
        PropertyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint16 private constant FEE_BPS = 37;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    uint256 private constant INITIAL = 1e60;

    SpotCLOBFactory private factory;
    SpotCLOB private book;
    AgnosticToken private base;
    AgnosticToken private quote;
    bytes32 private poolId;

    struct Maker {
        bytes32 id;
        uint128 price;
        uint128 quantity;
        uint128 expectedFill;
        bool cancelled;
    }

    function setUp() public {
        factory = new SpotCLOBFactory();
        base = new AgnosticToken(18);
        quote = new AgnosticToken(6);
        factory.setQuoteToken(address(quote), true);
        address deployed;
        (poolId, deployed) = factory.createPairWithFee(address(base), address(quote), FEE_BPS);
        book = SpotCLOB(deployed);
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function testFeeIncreaseKeepsBestBidFillableForLimitAndMarketSells() public {
        factory.setPairTradingFeeBps(address(base), address(quote), 10);
        bytes32 firstBid = _limit(ALICE, ISpotCLOB.Side.Buy, 1e18, 5e17);
        bytes32 secondBid = _limit(ALICE, ISpotCLOB.Side.Buy, 1e18, 5e17);
        factory.setPairTradingFeeBps(address(base), address(quote), 20);
        bytes32 lowerBid = _limit(BOB, ISpotCLOB.Side.Buy, 9e17, 1e18);

        _market(CAROL, ISpotCLOB.Side.Sell, 5e17, 0, 5e17, 0, 64);
        _limit(CAROL, ISpotCLOB.Side.Sell, 9e17, 5e17);

        (, ISpotCLOB.OrderState memory firstState) = book.getOrder(firstBid);
        (, ISpotCLOB.OrderState memory secondState) = book.getOrder(secondBid);
        (, ISpotCLOB.OrderState memory lowerState) = book.getOrder(lowerBid);
        require(
            firstState.status == ISpotCLOB.OrderStatus.Filled
                && secondState.status == ISpotCLOB.OrderStatus.Filled,
            "old-rate bids did not fill"
        );
        require(lowerState.filledQuantity == 0, "matching skipped price priority");
        require(
            book.accruedTradingFees(address(quote)) == 3_000,
            "maker and taker fees used the wrong rates"
        );
        _assertSolvent();
    }

    function testFuzz_FeeIncreaseDoesNotUnderflowRestingBid(uint16 oldSeed, uint16 newSeed) public {
        uint16 oldFee = oldSeed % 1_000;
        uint16 newFee = oldFee + 1 + newSeed % (1_000 - oldFee);
        factory.setPairTradingFeeBps(address(base), address(quote), oldFee);
        bytes32 bid = _limit(ALICE, ISpotCLOB.Side.Buy, 1e18, 1e18);
        factory.setPairTradingFeeBps(address(base), address(quote), newFee);
        (, uint128 filled, uint256 gross) = _market(BOB, ISpotCLOB.Side.Sell, 1e18, 0, 1e18, 0, 64);
        require(filled == 1e18 && gross == 1e6, "old bid became unfillable");
        (, ISpotCLOB.OrderState memory state) = book.getOrder(bid);
        require(state.status == ISpotCLOB.OrderStatus.Filled, "old bid remained open");
        require(
            book.accruedTradingFees(address(quote)) == (uint256(oldFee) + uint256(newFee)) * 100,
            "fill did not use both fee snapshots"
        );
        _assertSolvent();
    }

    function testOnePriceUnitImprovementJumpsExistingBidQueue() public {
        bytes32 earlier = _limit(ALICE, ISpotCLOB.Side.Buy, 1e18, 1e18);
        bytes32 improved = _limit(BOB, ISpotCLOB.Side.Buy, 1e18 + 1, 1e18);
        (uint256 firstQuantity,,) = book.getPriceLevel(poolId, ISpotCLOB.Side.Buy, 1e18);
        (uint256 secondQuantity,,) = book.getPriceLevel(poolId, ISpotCLOB.Side.Buy, 1e18 + 1);
        require(firstQuantity == 1e18 && secondQuantity == 1e18, "adjacent prices aggregated");
        (, uint128 filled, uint256 gross) =
            _market(CAROL, ISpotCLOB.Side.Sell, 1e18, 0, 1e18, 0, 64);
        require(filled == 1e18 && gross == 1e6, "wrong adjacent-price fill");
        (, ISpotCLOB.OrderState memory oldState) = book.getOrder(earlier);
        (, ISpotCLOB.OrderState memory newState) = book.getOrder(improved);
        require(
            oldState.filledQuantity == 0 && newState.filledQuantity == 1e18, "priority mismatch"
        );
        _assertSolvent();
    }

    function testMinimumNewOrderNotionalIsOneTenthUsdc() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SpotCLOB.MinimumOrderNotionalNotMet.selector, uint256(100_000), uint256(99_999)
            )
        );
        _limit(ALICE, ISpotCLOB.Side.Sell, 1e18, 1e17 - 1);
        _limit(ALICE, ISpotCLOB.Side.Sell, 1e18, 1e17);
        (, uint128 filled, uint256 gross) = _market(BOB, ISpotCLOB.Side.Buy, 1e17, 0, 1e17, 0, 64);
        require(filled == 1e17 && gross == 100_000, "minimum trade rejected");
        require(quote.balanceOf(ALICE) == INITIAL + 99_630, "wrong minimum trade proceeds");
        require(book.accruedTradingFees(address(quote)) == 740, "minimum trade fee changed");
        _assertSolvent();
    }

    function testFuzz_ZeroQuoteMakerRemainderIsRefunded(uint96 dustSeed, bool makerBuys) public {
        uint128 minimumQuantity = 1e17;
        uint128 dust = 1 + uint128(dustSeed % (1e12 - 1));
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 maker = _limit(ALICE, makerSide, 1e18, minimumQuantity + dust);

        _market(
            BOB,
            makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy,
            minimumQuantity,
            0,
            minimumQuantity,
            0,
            64
        );

        (, ISpotCLOB.OrderState memory state) = book.getOrder(maker);
        (,, bool resting) = book.getOrderLinks(maker);
        require(state.filledQuantity == minimumQuantity, "dust cleanup changed fill");
        require(state.status == ISpotCLOB.OrderStatus.Cancelled, "zero-quote dust remained open");
        require(!resting, "zero-quote dust remained linked");
        (, uint256 locked,) = book.balanceOf(ALICE, makerBuys ? address(quote) : address(base));
        require(locked == 0, "dust escrow was not refunded");
        _assertSolvent();
    }

    function testFuzz_SettlingSubFloorRemainderStaysMatchable(uint96 remainderSeed, bool makerBuys)
        public
    {
        uint128 minimumQuantity = 1e17;
        uint128 remainder =
            uint128(1e12 + uint256(remainderSeed) % (uint256(minimumQuantity) - 1e12));
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 maker = _limit(ALICE, makerSide, 1e18, minimumQuantity + remainder);

        _market(
            BOB,
            makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy,
            minimumQuantity,
            0,
            minimumQuantity,
            0,
            64
        );

        (, ISpotCLOB.OrderState memory state) = book.getOrder(maker);
        (,, bool resting) = book.getOrderLinks(maker);
        require(state.status == ISpotCLOB.OrderStatus.PartiallyFilled, "valid remainder was closed");
        require(resting, "valid remainder was unlinked");
        (uint256 levelQuantity,,) = book.getPriceLevel(poolId, makerSide, 1e18);
        require(levelQuantity == remainder, "valid remainder left wrong level quantity");
        (, uint256 locked,) = book.balanceOf(ALICE, makerBuys ? address(quote) : address(base));
        require(locked != 0, "valid remainder lost escrow");
        _assertSolvent();
    }

    function testFuzz_ZeroQuoteMarketSliceRevertsWithoutChangingMaker(
        uint96 dustSeed,
        bool makerBuys
    ) public {
        uint128 dust = uint128(1 + uint256(dustSeed) % (1e12 - 1));
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 maker = _limit(ALICE, makerSide, 1e18, 1e17);
        bytes32 before = _snapshot(maker);

        vm.expectRevert(SpotCLOB.NoLiquidity.selector);
        _market(BOB, makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy, dust, 0, 0, 0, 64);

        require(_snapshot(maker) == before, "zero-quote market attempt changed state");
    }

    function testFuzz_OneQuoteAtomMarketSliceFillsAndAccountsFeeDust(
        uint96 quantitySeed,
        bool makerBuys
    ) public {
        uint128 quantity = 1e12 + uint128(quantitySeed % 1e12);
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 maker = _limit(ALICE, makerSide, 1e18, 1e17);

        (bytes32 taker, uint128 filled, uint256 gross) = _market(
            BOB, makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy, quantity, 0, quantity, 0, 64
        );

        require(filled == quantity && gross == 1, "one-atom slice did not settle");
        (, ISpotCLOB.OrderState memory takerState) = book.getOrder(taker);
        require(takerState.status == ISpotCLOB.OrderStatus.Filled, "one-atom taker not filled");
        (, ISpotCLOB.OrderState memory makerState) = book.getOrder(maker);
        (,, bool makerResting) = book.getOrderLinks(maker);
        require(
            makerState.status == ISpotCLOB.OrderStatus.PartiallyFilled, "one-atom fill closed maker"
        );
        require(makerResting, "one-atom fill unlinked maker");
        require(book.accruedTradingFees(address(quote)) == 0, "fractional fee charged early");
        require(book.orderFeeRemainder(maker) == FEE_BPS, "maker fee dust mismatch");
        require(book.orderFeeRemainder(taker) == FEE_BPS, "taker fee dust mismatch");
        _assertSolvent();
    }

    function testFuzz_FeeCarryIsPartitionInvariantOnBothSides(
        uint32 totalSeed,
        uint32 splitSeed,
        bool makerBuys
    ) public {
        uint128 totalQuote = 100_000 + uint128(totalSeed % 900_001);
        uint128 totalQuantity = totalQuote * 1e12;
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 maker = _limit(ALICE, makerSide, 1e18, totalQuantity);
        ISpotCLOB.Side takerSide = makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy;
        uint32 partitionCount = 2 + (splitSeed >> 24) % 7;

        uint256 expectedTakerFees =
            _fillFeePartitions(takerSide, totalQuote, splitSeed, partitionCount);

        _assertPartitionedFeeSettlement(maker, makerBuys, totalQuote, expectedTakerFees);
        _assertSolvent();
    }

    function _fillFeePartitions(
        ISpotCLOB.Side takerSide,
        uint128 totalQuote,
        uint32 splitSeed,
        uint32 partitionCount
    ) private returns (uint256 expectedTakerFees) {
        uint128 remaining = totalQuote;
        for (uint32 i; i < partitionCount; ++i) {
            uint32 partitionsLeft = partitionCount - i;
            uint128 part = remaining;
            if (partitionsLeft != 1) {
                uint128 available = remaining - (partitionsLeft - 1);
                uint128 draw = uint128(splitSeed) + uint128(i) * 7_919;
                part = 1 + draw % available;
            }
            remaining -= part;
            uint128 quantity = part * 1e12;
            _market(i % 2 == 0 ? BOB : CAROL, takerSide, quantity, 0, quantity, 0, 64);
            expectedTakerFees += part * FEE_BPS / 10_000;
        }
    }

    function _assertPartitionedFeeSettlement(
        bytes32 maker,
        bool makerBuys,
        uint128 totalQuote,
        uint256 expectedTakerFees
    ) private view {
        uint256 expectedMakerFee = totalQuote * FEE_BPS / 10_000;
        uint256 expectedRemainder = totalQuote * FEE_BPS % 10_000;
        (, ISpotCLOB.OrderState memory makerState) = book.getOrder(maker);
        (, uint256 locked,) = book.balanceOf(ALICE, makerBuys ? address(quote) : address(base));
        require(makerState.status == ISpotCLOB.OrderStatus.Filled, "partitioned maker not filled");
        require(locked == 0, "partitioned maker retained escrow");
        require(book.orderFeeRemainder(maker) == expectedRemainder, "maker fee carry mismatch");
        require(
            book.accruedTradingFees(address(quote)) == expectedMakerFee + expectedTakerFees,
            "partition changed collected fees"
        );
        require(
            quote.balanceOf(ALICE)
                == (makerBuys
                        ? INITIAL - totalQuote - expectedMakerFee
                        : INITIAL + totalQuote - expectedMakerFee),
            "partition changed maker settlement"
        );
    }

    function testFuzz_MarketMatchingUsesPriceThenFIFO(uint256 seed, bool makerBuys) public {
        Maker[8] memory makers;
        uint128 total;
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        for (uint256 i; i < makers.length; ++i) {
            uint256 draw = uint256(keccak256(abi.encode(seed, i)));
            uint128 price = uint128(1 + draw % 3) * 1e18;
            uint128 quantity = uint128(1 + (draw >> 8) % 4) * 1e17;
            makers[i] = Maker(_limit(ALICE, makerSide, price, quantity), price, quantity, 0, false);
            total += quantity;
        }
        uint256 cancelled = seed % makers.length;
        vm.prank(ALICE);
        book.cancelOrder(makers[cancelled].id);
        makers[cancelled].cancelled = true;
        total -= makers[cancelled].quantity;
        uint128 requested = uint128(1 + (seed >> 8) % (total / 1e17)) * 1e17;
        (uint256 expectedQuote, uint256 expectedTakerFee, uint256 expectedMakerFees) =
            _referenceMatching(makers, requested, makerBuys);
        (, uint128 filled, uint256 gross) = _market(
            BOB,
            makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy,
            requested,
            0,
            requested,
            0,
            64
        );
        require(filled == requested && gross == expectedQuote, "market result differs from model");
        require(
            book.accruedTradingFees(address(quote)) == expectedTakerFee + expectedMakerFees,
            "per-order fee mismatch"
        );
        for (uint256 i; i < makers.length; ++i) {
            (, ISpotCLOB.OrderState memory state) = book.getOrder(makers[i].id);
            require(state.filledQuantity == makers[i].expectedFill, "price-time priority violated");
            if (makers[i].cancelled) {
                require(state.status == ISpotCLOB.OrderStatus.Cancelled, "cancelled order revived");
            }
        }
        require(
            quote.balanceOf(BOB)
                == (makerBuys
                        ? INITIAL + expectedQuote - expectedTakerFee
                        : INITIAL - expectedQuote - expectedTakerFee),
            "wrong taker fee or wallet settlement"
        );
        _assertSolvent();
    }

    function testFuzz_MarketProtectionsRevertAtomically(uint256 seed, bool makerBuys) public {
        uint128 quantity = uint128(1 + seed % 4) * 1e17;
        uint128 price = uint128(1 + (seed >> 8) % 4) * 1e18;
        bytes32 maker =
            _limit(ALICE, makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell, price, quantity);
        ISpotCLOB.Side side = makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy;
        bytes32 before = _snapshot(maker);
        vm.expectRevert(SpotCLOB.MinimumFillNotMet.selector);
        _market(BOB, side, quantity + 1e17, price, quantity + 1e17, 0, 64);
        require(_snapshot(maker) == before, "min-fill failure changed state");

        uint256 gross = uint256(price) * quantity / 1e30;
        uint256 net = makerBuys ? gross - gross * FEE_BPS / 10_000 : quantity;
        vm.expectRevert(SpotCLOB.MinimumReceiveNotMet.selector);
        _market(BOB, side, quantity, price, 0, net + 1, 64);
        require(_snapshot(maker) == before, "min-receive failure changed state");
        vm.expectRevert(SpotCLOB.NoLiquidity.selector);
        _market(BOB, side, quantity, makerBuys ? price + 1 : price - 1, 0, 0, 64);
        require(_snapshot(maker) == before, "price-limit failure changed state");
    }

    function testFuzz_GtcOrderRemainsMatchableAfterTimeAdvance(uint8 delaySeed, bool makerBuys)
        public
    {
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 maker = _limit(ALICE, makerSide, 1e18, 1e18);
        vm.warp(block.timestamp + 1 + delaySeed);
        ISpotCLOB.Side takerSide = makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy;
        _market(BOB, takerSide, 1e18, 0, 1e18, 0, 1);
        (, ISpotCLOB.OrderState memory makerState) = book.getOrder(maker);
        require(
            makerState.status == ISpotCLOB.OrderStatus.Filled && makerState.filledQuantity == 1e18,
            "GTC maker became unmatchable after time advance"
        );
        _assertSolvent();
    }

    function testFeeWithdrawalCannotSpendOrderEscrow() public {
        _limit(ALICE, ISpotCLOB.Side.Sell, 1e18, 1e18);
        _market(BOB, ISpotCLOB.Side.Buy, 1e18, 0, 1e18, 0, 64);
        bytes32 bid = _limit(CAROL, ISpotCLOB.Side.Buy, 1e18, 1e18);
        uint256 fees = book.accruedTradingFees(address(quote));
        require(fees == 7_400, "fees were not exercised");
        bytes32 before = _snapshot(bid);
        vm.prank(ALICE);
        vm.expectRevert(SpotCLOB.Unauthorized.selector);
        book.withdrawTradingFees(address(quote), BOB, fees);
        vm.expectRevert(SpotCLOB.InsufficientAccruedFees.selector);
        book.withdrawTradingFees(address(quote), BOB, fees + 1);
        require(_snapshot(bid) == before, "rejected withdrawal changed balances");
        uint256 bobBefore = quote.balanceOf(BOB);
        book.withdrawTradingFees(address(quote), BOB, fees);
        require(quote.balanceOf(BOB) == bobBefore + fees, "fees not paid to recipient");
        require(book.accruedTradingFees(address(quote)) == 0, "withdrawn fees still accrued");
        vm.prank(CAROL);
        book.cancelOrder(bid);
        require(quote.balanceOf(CAROL) == INITIAL, "withdrawal consumed buyer escrow");
        _assertSolvent();
    }

    function _referenceMatching(Maker[8] memory makers, uint128 remaining, bool makerBuys)
        private
        pure
        returns (uint256 gross, uint256 takerFee, uint256 makerFees)
    {
        while (remaining != 0) {
            uint256 best = makers.length;
            for (uint256 i; i < makers.length; ++i) {
                if (makers[i].cancelled || makers[i].expectedFill == makers[i].quantity) continue;
                if (
                    best == makers.length
                        || (makerBuys
                                ? makers[i].price > makers[best].price
                                : makers[i].price < makers[best].price)
                ) best = i;
            }
            require(best != makers.length, "reference ran out of makers");
            uint128 available = makers[best].quantity - makers[best].expectedFill;
            uint128 fill = remaining < available ? remaining : available;
            makers[best].expectedFill += fill;
            remaining -= fill;
            uint256 quoteFilled = uint256(makers[best].price) * fill / 1e30;
            gross += quoteFilled;
        }
        takerFee = gross * FEE_BPS / 10_000;
        for (uint256 i; i < makers.length; ++i) {
            uint256 makerGross = uint256(makers[i].price) * makers[i].expectedFill / 1e30;
            makerFees += makerGross * FEE_BPS / 10_000;
        }
    }

    function _fund(address trader) private {
        base.mint(trader, INITIAL);
        quote.mint(trader, INITIAL);
        vm.prank(trader);
        base.approve(address(book), type(uint256).max);
        vm.prank(trader);
        quote.approve(address(book), type(uint256).max);
    }

    function _limit(address trader, ISpotCLOB.Side side, uint128 price, uint128 quantity)
        private
        returns (bytes32)
    {
        ISpotCLOB.LimitOrder memory order = ISpotCLOB.LimitOrder({
            trader: trader,
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: side,
            price: price,
            quantity: quantity,
            clientOrderId: 0
        });
        vm.prank(trader);
        return book.placeLimitOrder(order);
    }

    function _market(
        address trader,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint128 priceLimit,
        uint128 minFill,
        uint256 minReceive,
        uint32 steps
    ) private returns (bytes32, uint128, uint256) {
        ISpotCLOB.MarketOrder memory order = ISpotCLOB.MarketOrder({
            trader: trader,
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: side,
            quantity: quantity,
            priceLimit: priceLimit,
            minFillQuantity: minFill,
            minReceive: minReceive,
            clientOrderId: 0
        });
        vm.prank(trader);
        return book.executeMarketOrder(order, steps);
    }

    function _snapshot(bytes32 makerId) private view returns (bytes32) {
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(makerId);
        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            book.getOrderBook(poolId, 256);
        bytes32 wallets = keccak256(
            abi.encode(
                base.balanceOf(ALICE),
                base.balanceOf(BOB),
                base.balanceOf(CAROL),
                base.balanceOf(address(book)),
                quote.balanceOf(ALICE),
                quote.balanceOf(BOB),
                quote.balanceOf(CAROL),
                quote.balanceOf(address(book))
            )
        );
        bytes32 liabilities = keccak256(
            abi.encode(_accountSnapshot(ALICE), _accountSnapshot(BOB), _accountSnapshot(CAROL))
        );
        return keccak256(
            abi.encode(
                order,
                state,
                bids,
                asks,
                wallets,
                liabilities,
                book.bookSequence(poolId),
                book.accruedTradingFees(address(quote))
            )
        );
    }

    function _accountSnapshot(address trader) private view returns (bytes32) {
        (uint256 freeBase, uint256 lockedBase, uint256 totalBase) =
            book.balanceOf(trader, address(base));
        (uint256 freeQuote, uint256 lockedQuote, uint256 totalQuote) =
            book.balanceOf(trader, address(quote));
        return keccak256(
            abi.encode(freeBase, lockedBase, totalBase, freeQuote, lockedQuote, totalQuote)
        );
    }

    function _assertSolvent() private view {
        uint256 baseLocked;
        uint256 quoteLocked;
        address[3] memory traders = [ALICE, BOB, CAROL];
        uint256 baseWallets;
        uint256 quoteWallets;
        for (uint256 i; i < traders.length; ++i) {
            (, uint256 lockedBase,) = book.balanceOf(traders[i], address(base));
            (, uint256 lockedQuote,) = book.balanceOf(traders[i], address(quote));
            baseLocked += lockedBase;
            quoteLocked += lockedQuote;
            baseWallets += base.balanceOf(traders[i]);
            quoteWallets += quote.balanceOf(traders[i]);
        }
        require(base.balanceOf(address(book)) == baseLocked, "base escrow insolvent");
        require(
            quote.balanceOf(address(book)) == quoteLocked + book.accruedTradingFees(address(quote)),
            "quote escrow and fees insolvent"
        );
        require(baseWallets + base.balanceOf(address(book)) == INITIAL * 3, "base supply lost");
        require(quoteWallets + quote.balanceOf(address(book)) == INITIAL * 3, "quote supply lost");
    }
}
