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
        (uint128 firstQuantity,,) = book.getPriceLevel(poolId, ISpotCLOB.Side.Buy, 1e18);
        (uint128 secondQuantity,,) = book.getPriceLevel(poolId, ISpotCLOB.Side.Buy, 1e18 + 1);
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

    function testMinimumTradeIsOneUsdcAtomRatherThanOneUsdc() public {
        vm.expectRevert(SpotCLOB.InvalidLotQuantity.selector);
        _limit(ALICE, ISpotCLOB.Side.Sell, 1e18, 1e12 - 1);
        _limit(ALICE, ISpotCLOB.Side.Sell, 1e18, 1e12);
        (, uint128 filled, uint256 gross) = _market(BOB, ISpotCLOB.Side.Buy, 1e12, 0, 1e12, 0, 64);
        require(filled == 1e12 && gross == 1, "one-atom trade rejected");
        require(quote.balanceOf(ALICE) == INITIAL + 1, "wrong minimum trade proceeds");
        require(book.accruedTradingFees(address(quote)) == 0, "one-atom trade charged fees");
        _assertSolvent();
    }

    function testFuzz_MarketMatchingUsesPriceThenFIFO(uint256 seed, bool makerBuys) public {
        Maker[8] memory makers;
        uint128 total;
        ISpotCLOB.Side makerSide = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        for (uint256 i; i < makers.length; ++i) {
            uint256 draw = uint256(keccak256(abi.encode(seed, i)));
            uint128 price = uint128(1 + draw % 3) * 1e18;
            uint128 quantity = uint128(1 + (draw >> 8) % 4) * 1e15;
            makers[i] = Maker(_limit(ALICE, makerSide, price, quantity), price, quantity, 0, false);
            total += quantity;
        }
        uint256 cancelled = seed % makers.length;
        vm.prank(ALICE);
        book.cancelOrder(makers[cancelled].id);
        makers[cancelled].cancelled = true;
        total -= makers[cancelled].quantity;
        uint128 requested = uint128(1 + (seed >> 8) % (total / 1e15)) * 1e15;
        (uint256 expectedQuote, uint256 expectedFees) =
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
            book.accruedTradingFees(address(quote)) == expectedFees * 2, "per-fill fee mismatch"
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
                        ? INITIAL + expectedQuote - expectedFees
                        : INITIAL - expectedQuote - expectedFees),
            "wrong taker fee or wallet settlement"
        );
        _assertSolvent();
    }

    function testFuzz_MarketProtectionsRevertAtomically(uint256 seed, bool makerBuys) public {
        uint128 quantity = uint128(1 + seed % 4) * 1e15;
        uint128 price = uint128(1 + (seed >> 8) % 4) * 1e18;
        bytes32 maker =
            _limit(ALICE, makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell, price, quantity);
        ISpotCLOB.Side side = makerBuys ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy;
        bytes32 before = _snapshot(maker);
        vm.expectRevert(SpotCLOB.MinimumFillNotMet.selector);
        _market(BOB, side, quantity + 1e15, price, quantity + 1e15, 0, 64);
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
        returns (uint256 gross, uint256 fees)
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
            fees += quoteFilled * FEE_BPS / 10_000;
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
