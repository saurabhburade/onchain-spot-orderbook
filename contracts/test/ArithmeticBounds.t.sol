// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotPriceMath } from "../src/libraries/SpotPriceMath.sol";
import { AgnosticToken } from "./AgnosticPricing.t.sol";
import { PropertyVm } from "./AgnosticProperties.t.sol";

contract ArithmeticBoundsTest {
    PropertyVm private constant vm =
        PropertyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint16 private constant FEE_BPS = 37;
    uint256 private constant NORMAL_BALANCE = 1e60;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    address private constant UNFUNDED = address(0xDAD);

    SpotCLOBFactory private factory;
    SpotCLOB private book;
    AgnosticToken private base;
    AgnosticToken private quote;
    bytes32 private poolId;

    function setUp() public {
        _deploy(false);
    }

    function testFullWidthPriceAndQuantitySettleWithoutOverflow() public {
        uint128 maximum = type(uint128).max;
        uint256 gross = uint256(maximum) * maximum / 1e30;
        uint256 fee = gross * FEE_BPS / 10_000;
        bytes32 ask = _limit(ALICE, ISpotCLOB.Side.Sell, maximum, maximum);
        bytes32 bid = _limit(BOB, ISpotCLOB.Side.Buy, maximum, maximum);

        (, ISpotCLOB.OrderState memory askState) = book.getOrder(ask);
        (, ISpotCLOB.OrderState memory bidState) = book.getOrder(bid);
        require(askState.status == ISpotCLOB.OrderStatus.Filled, "maximum ask did not fill");
        require(bidState.status == ISpotCLOB.OrderStatus.Filled, "maximum bid did not fill");
        require(
            askState.filledQuantity == maximum && bidState.filledQuantity == maximum,
            "maximum quantity was truncated"
        );
        require(
            askState.filledQuoteQuantity == gross && bidState.filledQuoteQuantity == gross,
            "maximum quote was truncated"
        );
        require(
            base.balanceOf(ALICE) == NORMAL_BALANCE - maximum,
            "seller base balance changed incorrectly"
        );
        require(
            base.balanceOf(BOB) == NORMAL_BALANCE + maximum,
            "buyer base balance changed incorrectly"
        );
        require(
            quote.balanceOf(ALICE) == NORMAL_BALANCE + gross - fee, "seller quote or fee incorrect"
        );
        require(
            quote.balanceOf(BOB) == NORMAL_BALANCE - gross - fee, "buyer quote or fee incorrect"
        );
        require(book.accruedTradingFees(address(quote)) == fee * 2, "maximum trade fees incorrect");
        (bool bidExists,,, bool askExists,,) = book.getBestPrices(poolId);
        require(!bidExists && !askExists, "filled full-width orders remained on book");
        _assertConservation(NORMAL_BALANCE);
    }

    function testFuzz_PriceLevelQuantityOverflowRollsBack(uint128 offset, bool makerBuys) public {
        // The one-atom order remains valid while the first level already holds uint128.max.
        uint128 price = uint128(1e30 + uint256(offset % 1e29));
        ISpotCLOB.Side side = makerBuys ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell;
        bytes32 first = _limit(ALICE, side, price, type(uint128).max);
        bytes32 before = _snapshot(first, price, side);

        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", uint256(0x11)));
        _limit(CAROL, side, price, 1);
        require(
            _snapshot(first, price, side) == before, "overflow kept partial escrow or book state"
        );
        (uint128 total, bytes32 head, bytes32 tail) = book.getPriceLevel(poolId, side, price);
        require(
            total == type(uint128).max && head == first && tail == first,
            "overflow corrupted the level"
        );

        vm.prank(ALICE);
        book.cancelOrder(first);
        bytes32 second = _limit(CAROL, side, price, 1);
        require(second == bytes32(uint256(2)), "reverted order consumed an id");
        (total, head, tail) = book.getPriceLevel(poolId, side, price);
        require(
            total == 1 && head == second && tail == second, "level did not recover after overflow"
        );
        _assertConservation(NORMAL_BALANCE);
    }

    function testFuzz_UnfundedOrderCannotUnderflowTokenBalances(uint128 quantitySeed, bool buy)
        public
    {
        uint128 quantity = quantitySeed == 0 ? 1 : quantitySeed;
        vm.prank(UNFUNDED);
        base.approve(address(book), type(uint256).max);
        vm.prank(UNFUNDED);
        quote.approve(address(book), type(uint256).max);
        vm.expectRevert(SpotCLOB.TokenTransferFailed.selector);
        _limit(UNFUNDED, buy ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell, 1e30, quantity);
        (bool bidExists,,, bool askExists,,) = book.getBestPrices(poolId);
        require(!bidExists && !askExists, "unfunded order changed the book");
        require(book.bookSequence(poolId) == 0, "unfunded order advanced the sequence");
        require(
            base.balanceOf(address(book)) == 0 && quote.balanceOf(address(book)) == 0,
            "unfunded order locked tokens"
        );
        (, uint256 baseLocked,) = book.balanceOf(UNFUNDED, address(base));
        (, uint256 quoteLocked,) = book.balanceOf(UNFUNDED, address(quote));
        require(baseLocked == 0 && quoteLocked == 0, "unfunded order acquired liabilities");
    }

    function testHighestSupportedDecimalExponentSettlesFullWidthProduct() public {
        _deploy(true); // 18 + 59 - 0 = 77, the largest supported denominator exponent.
        uint128 maximum = type(uint128).max;
        require(
            SpotPriceMath.quoteAmount(maximum, maximum, 59, 0) == 1, "unexpected boundary quote"
        );
        bytes32 ask = _limit(ALICE, ISpotCLOB.Side.Sell, maximum, maximum);
        bytes32 bid = _limit(BOB, ISpotCLOB.Side.Buy, maximum, maximum);
        (, ISpotCLOB.OrderState memory askState) = book.getOrder(ask);
        (, ISpotCLOB.OrderState memory bidState) = book.getOrder(bid);
        require(
            askState.filledQuoteQuantity == 1 && bidState.filledQuoteQuantity == 1,
            "77-decimal conversion overflowed"
        );
        require(
            askState.status == ISpotCLOB.OrderStatus.Filled
                && bidState.status == ISpotCLOB.OrderStatus.Filled,
            "boundary orders did not fill"
        );
        require(book.accruedTradingFees(address(quote)) == 0, "one-atom fee failed to round down");
        require(
            quote.balanceOf(ALICE) == 11 && quote.balanceOf(BOB) == 9,
            "boundary quote settlement incorrect"
        );
        _assertConservation(maximum);
    }

    function testUnsupportedDenominatorCannotCreatePartiallyInitializedPair() public {
        AgnosticToken unsupportedBase = new AgnosticToken(60);
        AgnosticToken zeroDecimalQuote = new AgnosticToken(0);
        factory.setQuoteToken(address(zeroDecimalQuote), true);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpotPriceMath.UnsupportedDecimalRelationship.selector, uint8(60), uint8(0)
            )
        );
        factory.createPair(address(unsupportedBase), address(zeroDecimalQuote));
        bytes32 failedId = factory.pairId(address(unsupportedBase), address(zeroDecimalQuote));
        require(!factory.getPool(failedId).exists, "failed pair retained registry state");
    }

    function _deploy(bool extremeDecimals) private {
        factory = new SpotCLOBFactory();
        base = new AgnosticToken(extremeDecimals ? 59 : 18);
        quote = new AgnosticToken(extremeDecimals ? 0 : 6);
        factory.setQuoteToken(address(quote), true);
        address deployed;
        (poolId, deployed) = factory.createPairWithFee(address(base), address(quote), FEE_BPS);
        book = SpotCLOB(deployed);
        uint256 baseBalance = extremeDecimals ? type(uint128).max : NORMAL_BALANCE;
        uint256 quoteBalance = extremeDecimals ? 10 : NORMAL_BALANCE;
        _fund(ALICE, baseBalance, quoteBalance);
        _fund(BOB, baseBalance, quoteBalance);
        _fund(CAROL, baseBalance, quoteBalance);
    }

    function _fund(address trader, uint256 baseAmount, uint256 quoteAmount) private {
        base.mint(trader, baseAmount);
        quote.mint(trader, quoteAmount);
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
            expiry: 0,
            clientOrderId: 0
        });
        vm.prank(trader);
        return book.placeLimitOrder(order);
    }

    function _snapshot(bytes32 orderId, uint128 price, ISpotCLOB.Side side)
        private
        view
        returns (bytes32)
    {
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(orderId);
        (uint128 quantity, bytes32 head, bytes32 tail) = book.getPriceLevel(poolId, side, price);
        return keccak256(
            abi.encode(
                order,
                state,
                quantity,
                head,
                tail,
                book.bookSequence(poolId),
                _tokenSnapshot(),
                _lockedSnapshot()
            )
        );
    }

    function _tokenSnapshot() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                base.balanceOf(ALICE),
                base.balanceOf(CAROL),
                base.balanceOf(address(book)),
                quote.balanceOf(ALICE),
                quote.balanceOf(CAROL),
                quote.balanceOf(address(book))
            )
        );
    }

    function _lockedSnapshot() private view returns (bytes32) {
        (, uint256 aliceBaseLocked,) = book.balanceOf(ALICE, address(base));
        (, uint256 aliceQuoteLocked,) = book.balanceOf(ALICE, address(quote));
        (, uint256 carolBaseLocked,) = book.balanceOf(CAROL, address(base));
        (, uint256 carolQuoteLocked,) = book.balanceOf(CAROL, address(quote));
        return keccak256(
            abi.encode(aliceBaseLocked, aliceQuoteLocked, carolBaseLocked, carolQuoteLocked)
        );
    }

    function _assertConservation(uint256 initialBase) private view {
        uint256 baseWallets;
        uint256 quoteWallets;
        uint256 baseLocked;
        uint256 quoteLocked;
        address[3] memory traders = [ALICE, BOB, CAROL];
        for (uint256 i; i < traders.length; ++i) {
            baseWallets += base.balanceOf(traders[i]);
            quoteWallets += quote.balanceOf(traders[i]);
            (, uint256 lockedBase,) = book.balanceOf(traders[i], address(base));
            (, uint256 lockedQuote,) = book.balanceOf(traders[i], address(quote));
            baseLocked += lockedBase;
            quoteLocked += lockedQuote;
        }
        require(base.balanceOf(address(book)) == baseLocked, "base escrow mismatch");
        require(
            quote.balanceOf(address(book)) == quoteLocked + book.accruedTradingFees(address(quote)),
            "quote escrow or fee mismatch"
        );
        require(
            baseWallets + base.balanceOf(address(book)) == initialBase * 3, "base supply changed"
        );
        require(
            quoteWallets + quote.balanceOf(address(book))
                == (initialBase == NORMAL_BALANCE ? NORMAL_BALANCE * 3 : 30),
            "quote supply changed"
        );
    }
}
