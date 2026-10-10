// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

contract AuditPricingToken {
    uint8 public immutable decimals;
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address account => mapping(address spender => uint256 allowance)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = allowance[sender][msg.sender];
        if (approved != type(uint256).max) allowance[sender][msg.sender] = approved - amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract AuditPricingActor {
    function approve(AuditPricingToken token, SpotCLOB book) external {
        token.approve(address(book), type(uint256).max);
    }

    function place(
        SpotCLOB book,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
    ) external returns (bytes32) {
        return book.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                price: price,
                quantity: quantity,
                clientOrderId: 0
            })
        );
    }

    function attemptPlace(
        SpotCLOB book,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
    ) external returns (bool success) {
        ISpotCLOB.LimitOrder memory order = ISpotCLOB.LimitOrder({
            trader: address(this),
            baseAsset: baseAsset,
            quoteAsset: quoteAsset,
            side: side,
            price: price,
            quantity: quantity,
            clientOrderId: 0
        });
        (success,) = address(book).call(abi.encodeCall(SpotCLOB.placeLimitOrder, (order)));
    }

    function cancel(SpotCLOB book, bytes32 orderId) external {
        book.cancelOrder(orderId);
    }

    function marketBuy(
        SpotCLOB book,
        address baseAsset,
        address quoteAsset,
        uint128 quantity,
        uint128 priceLimit
    ) external returns (uint128 filledQuantity, uint256 quoteQuantity) {
        (, filledQuantity, quoteQuantity) = book.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: ISpotCLOB.Side.Buy,
                quantity: quantity,
                priceLimit: priceLimit,
                minFillQuantity: quantity,
                minReceive: 0,
                clientOrderId: 0
            }),
            64
        );
    }
}

contract AuditPricingFindingsTest {
    uint128 private constant ONE_USDC_PER_TOKEN = 1e18;
    uint128 private constant DUST_PRICE = 1e7;
    uint128 private constant DUST_MINIMUM = 100_000 ether;
    uint128 private constant MAX_UINT128 = type(uint128).max;

    /// @dev I-04 is NatSpec-only and is intentionally omitted: its assertion is documentation
    /// quality, not runtime behavior that a Foundry test can meaningfully distinguish.
    function testL01_ZeroQuoteSliceRefundsTakerWithoutRemovingValidMaker() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor dustSeller = new AuditPricingActor();
        AuditPricingActor honestSeller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();

        _fundBase(book, base, dustSeller, DUST_MINIMUM);
        _fundBase(book, base, honestSeller, 1e12);
        _fundQuote(book, quote, buyer, 2);

        bytes32 dustAsk = dustSeller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, DUST_PRICE, DUST_MINIMUM
        );
        honestSeller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, 1e12
        );

        // The buy is valid at its own price, but this taker slice is too small to produce one
        // quote atom at DUST_PRICE. It must be refunded without deleting the valid maker.
        bytes32 rejectedRemainder =
            buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 2e18, 1e12);
        {
            (, ISpotCLOB.OrderState memory buyState) = book.getOrder(rejectedRemainder);
            require(buyState.filledQuantity == 0, "dust ask unexpectedly filled the buy");
            require(
                buyState.status == ISpotCLOB.OrderStatus.Cancelled, "buy remainder was not closed"
            );
        }
        _assertUnlinked(book, rejectedRemainder);
        require(quote.balanceOf(address(buyer)) == 2, "buyer escrow was not refunded");
        (, uint256 buyerLocked,) = book.balanceOf(address(buyer), address(quote));
        require(buyerLocked == 0, "buyer retains locked quote");

        (,, bool makerResting) = book.getOrderLinks(dustAsk);
        require(makerResting, "valid maker was removed by tiny taker");
        _assertOnlyBestAsk(book, poolId, DUST_PRICE);

        dustSeller.cancel(book, dustAsk);
        _assertOnlyBestAsk(book, poolId, ONE_USDC_PER_TOKEN);
    }

    function testL01_MakerRemainderDustIsRefundedAndUnlinked() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();
        uint128 makerQuantity = 2e12;
        uint128 fillQuantity = 1e12 + 1;

        _fundBase(book, base, seller, makerQuantity);
        _fundQuote(book, quote, buyer, 1);
        bytes32 ask = seller.place(
            book,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            ONE_USDC_PER_TOKEN,
            makerQuantity
        );
        bytes32 buy = buyer.place(
            book,
            address(base),
            address(quote),
            ISpotCLOB.Side.Buy,
            ONE_USDC_PER_TOKEN,
            fillQuantity
        );

        (, ISpotCLOB.OrderState memory askState) = book.getOrder(ask);
        (, ISpotCLOB.OrderState memory buyState) = book.getOrder(buy);
        require(askState.filledQuantity == fillQuantity, "maker fill changed");
        require(askState.status == ISpotCLOB.OrderStatus.Cancelled, "maker dust was not closed");
        require(buyState.status == ISpotCLOB.OrderStatus.Filled, "taker was not filled");
        _assertUnlinked(book, ask);
        require(base.balanceOf(address(seller)) == makerQuantity - fillQuantity, "maker dust lost");
        require(quote.balanceOf(address(seller)) == 1, "maker proceeds changed");
        require(base.balanceOf(address(buyer)) == fillQuantity, "taker base payout changed");
        (, uint256 sellerLocked,) = book.balanceOf(address(seller), address(base));
        require(sellerLocked == 0, "maker dust remains locked");
        _assertEmptyBook(book, poolId);
    }

    function testL01_TakerRemainderDustIsRefundedAndUnlinked() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();
        uint128 makerQuantity = 1e12 + 1;
        uint128 takerQuantity = 2e12;

        _fundBase(book, base, seller, makerQuantity);
        _fundQuote(book, quote, buyer, 2);
        bytes32 ask = seller.place(
            book,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            ONE_USDC_PER_TOKEN,
            makerQuantity
        );
        bytes32 buy = buyer.place(
            book,
            address(base),
            address(quote),
            ISpotCLOB.Side.Buy,
            ONE_USDC_PER_TOKEN,
            takerQuantity
        );

        (, ISpotCLOB.OrderState memory askState) = book.getOrder(ask);
        (, ISpotCLOB.OrderState memory buyState) = book.getOrder(buy);
        require(askState.status == ISpotCLOB.OrderStatus.Filled, "maker was not filled");
        require(buyState.filledQuantity == makerQuantity, "taker fill changed");
        require(buyState.status == ISpotCLOB.OrderStatus.Cancelled, "taker dust was not closed");
        _assertUnlinked(book, buy);
        require(quote.balanceOf(address(buyer)) == 1, "taker rounding refund changed");
        require(base.balanceOf(address(buyer)) == makerQuantity, "taker base payout changed");
        require(quote.balanceOf(address(seller)) == 1, "maker proceeds changed");
        (, uint256 buyerLocked,) = book.balanceOf(address(buyer), address(quote));
        require(buyerLocked == 0, "taker dust remains locked");
        _assertEmptyBook(book, poolId);
    }

    function testL01_ExactQuoteAtomBoundaryFillsNormally() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();
        uint128 quantity = 1e12;

        _fundBase(book, base, seller, quantity);
        _fundQuote(book, quote, buyer, 1);
        bytes32 ask = seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, quantity
        );
        bytes32 buy = buyer.place(
            book, address(base), address(quote), ISpotCLOB.Side.Buy, ONE_USDC_PER_TOKEN, quantity
        );

        (, ISpotCLOB.OrderState memory askState) = book.getOrder(ask);
        (, ISpotCLOB.OrderState memory buyState) = book.getOrder(buy);
        require(askState.status == ISpotCLOB.OrderStatus.Filled, "one-atom maker not filled");
        require(buyState.status == ISpotCLOB.OrderStatus.Filled, "one-atom taker not filled");
        require(quote.balanceOf(address(seller)) == 1, "one quote atom not settled");
        _assertEmptyBook(book, poolId);
    }

    function testL01_ZeroQuoteRefundIncludesFeeReserve() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(18, 6, 100);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();
        uint128 takerQuantity = 1 ether;
        uint256 buyerFunding = 2_020_000;

        _fundBase(book, base, seller, DUST_MINIMUM);
        _fundQuote(book, quote, buyer, buyerFunding);
        bytes32 ask = seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, DUST_PRICE, DUST_MINIMUM
        );
        bytes32 buy = buyer.place(
            book, address(base), address(quote), ISpotCLOB.Side.Buy, 2e18, takerQuantity
        );

        (, ISpotCLOB.OrderState memory buyState) = book.getOrder(buy);
        require(buyState.status == ISpotCLOB.OrderStatus.Cancelled, "fee-backed dust not closed");
        require(quote.balanceOf(address(buyer)) == buyerFunding, "fee reserve was not refunded");
        (, uint256 buyerLocked,) = book.balanceOf(address(buyer), address(quote));
        require(buyerLocked == 0, "fee reserve remains locked");
        (,, bool makerResting) = book.getOrderLinks(ask);
        require(makerResting, "valid maker was griefed");
        require(book.accruedTradingFees(address(quote)) == 0, "fee charged without a fill");
    }

    function testKnownIssue_I01_SplittingSubThresholdFillsReducesFees() public {
        uint256 singleFillFees = _legacyFeeScenario(false);
        uint256 splitFillFees = _legacyFeeScenario(true);

        require(singleFillFees == 2, "single fill did not charge maker and taker fees");
        require(splitFillFees == 0, "split fills unexpectedly charged full fees");
        require(splitFillFees < singleFillFees, "splitting did not reduce accrued fees");
    }

    function testKnownIssue_I02_ManyPartialFillsPayLessQuoteThanOneFill() public {
        uint256 singleFillProceeds = _partialAskScenario(false);
        uint256 fragmentedProceeds = _partialAskScenario(true);

        require(singleFillProceeds == 3, "single fill quote changed");
        require(fragmentedProceeds == 2, "partial-fill rounding was not reproduced");
        require(
            fragmentedProceeds < singleFillProceeds,
            "many fills did not pay less quote than one fill"
        );
    }

    function testKnownIssue_I03_SaturatedMinimumQuantityCannotSettle() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(59, 0, 0);
        SpotCLOBLens lens = new SpotCLOBLens();
        AuditPricingActor seller = new AuditPricingActor();

        uint128 minimum = lens.minimumOrderQuantity(book, address(base), address(quote), uint128(1));
        require(minimum == MAX_UINT128, "minimum quantity did not saturate");
        require(
            lens.quoteAmount(book, address(base), address(quote), 1, minimum) == 0,
            "saturated minimum unexpectedly settled"
        );

        _fundBase(book, base, seller, minimum);
        require(
            !seller.attemptPlace(
                book, address(base), address(quote), ISpotCLOB.Side.Sell, 1, minimum
            ),
            "unrepresentable minimum quantity was accepted"
        );
    }

    function testKnownIssue_I05_MaxQuantitySaturatesPriceLevel() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor firstSeller = new AuditPricingActor();
        AuditPricingActor secondSeller = new AuditPricingActor();
        uint128 price = 1e30;

        _fundBase(book, base, firstSeller, MAX_UINT128);
        _fundBase(book, base, secondSeller, 1);
        bytes32 first = firstSeller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, price, MAX_UINT128
        );
        require(
            !secondSeller.attemptPlace(
                book, address(base), address(quote), ISpotCLOB.Side.Sell, price, 1
            ),
            "second order at saturated level succeeded"
        );

        (uint128 levelQuantity, bytes32 head, bytes32 tail) =
            book.getPriceLevel(poolId, ISpotCLOB.Side.Sell, price);
        require(levelQuantity == MAX_UINT128, "saturated level quantity changed");
        require(head == first && tail == first, "saturated level links changed");
    }

    function _legacyFeeScenario(bool split) private returns (uint256) {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        AuditPricingToken base = new AuditPricingToken(0);
        AuditPricingToken quote = new AuditPricingToken(0);
        factory.setQuoteToken(address(quote), true);
        factory.setDefaultTradingFeeBps(1_000);
        (, address deployed) = factory.createPair(
            address(base), address(quote), uint128(1), uint128(1), uint24(1), uint24(10)
        );
        SpotCLOB book = SpotCLOB(deployed);
        AuditPricingActor sellerA = new AuditPricingActor();
        AuditPricingActor sellerB = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();
        _fundBase(book, base, sellerA, 5);
        _fundBase(book, base, sellerB, 5);
        _fundQuote(book, quote, buyer, 11);

        if (split) {
            sellerA.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 1, 5);
            sellerB.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 1, 5);
        } else {
            _fundBase(book, base, sellerA, 5);
            sellerA.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 1, 10);
        }
        buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 1, 10);
        return book.accruedTradingFees(address(quote));
    }

    function _partialAskScenario(bool fragmented) private returns (uint256) {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor firstBuyer = new AuditPricingActor();
        AuditPricingActor secondBuyer = new AuditPricingActor();
        uint128 totalQuantity = 3e12;
        uint128 partialQuantity = 15e11;
        uint128 price = ONE_USDC_PER_TOKEN;

        _fundBase(book, base, seller, totalQuantity);
        _fundQuote(book, quote, firstBuyer, 3);
        _fundQuote(book, quote, secondBuyer, 3);
        seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, price, totalQuantity);

        if (fragmented) {
            firstBuyer.marketBuy(book, address(base), address(quote), partialQuantity, price);
            secondBuyer.marketBuy(book, address(base), address(quote), partialQuantity, price);
        } else {
            firstBuyer.marketBuy(book, address(base), address(quote), totalQuantity, price);
        }
        return quote.balanceOf(address(seller));
    }

    function _deployAgnostic(uint8 baseDecimals, uint8 quoteDecimals, uint16 feeBps)
        private
        returns (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId)
    {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        base = new AuditPricingToken(baseDecimals);
        quote = new AuditPricingToken(quoteDecimals);
        factory.setQuoteToken(address(quote), true);
        address deployed;
        (poolId, deployed) = factory.createPairWithFee(address(base), address(quote), feeBps);
        book = SpotCLOB(deployed);
    }

    function _fundBase(
        SpotCLOB book,
        AuditPricingToken base,
        AuditPricingActor actor,
        uint256 amount
    ) private {
        base.mint(address(actor), amount);
        actor.approve(base, book);
    }

    function _fundQuote(
        SpotCLOB book,
        AuditPricingToken quote,
        AuditPricingActor actor,
        uint256 amount
    ) private {
        quote.mint(address(actor), amount);
        actor.approve(quote, book);
    }

    function _assertUnlinked(SpotCLOB book, bytes32 orderId) private view {
        (bytes32 previous, bytes32 next, bool resting) = book.getOrderLinks(orderId);
        require(!resting && previous == bytes32(0) && next == bytes32(0), "order remains linked");
    }

    function _assertOnlyBestAsk(SpotCLOB book, bytes32 poolId, uint128 expectedPrice) private view {
        (bool bidExists,,, bool askExists, uint128 askPrice,) = book.getBestPrices(poolId);
        require(!bidExists && askExists && askPrice == expectedPrice, "unexpected best prices");
    }

    function _assertEmptyBook(SpotCLOB book, bytes32 poolId) private view {
        (bool bidExists,,, bool askExists,,) = book.getBestPrices(poolId);
        require(!bidExists && !askExists, "closed orders remain on book");
    }
}
