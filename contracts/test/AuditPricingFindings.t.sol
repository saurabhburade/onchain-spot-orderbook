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
    uint128 private constant DUST_MINIMUM = 10_000_000_000 ether;
    uint128 private constant MINIMUM_AT_ONE_USDC = 1e17;
    uint256 private constant MINIMUM_QUOTE = 100_000;
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
        _fundBase(book, base, honestSeller, MINIMUM_AT_ONE_USDC);
        _fundQuote(book, quote, buyer, MINIMUM_QUOTE);

        bytes32 dustAsk = dustSeller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, DUST_PRICE, DUST_MINIMUM
        );
        honestSeller.place(
            book,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            ONE_USDC_PER_TOKEN,
            MINIMUM_AT_ONE_USDC
        );

        // The buy is valid at its own price, but this taker slice is too small to produce one
        // quote atom at DUST_PRICE. It must be refunded without deleting the valid maker.
        bytes32 rejectedRemainder =
            buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 2e18, 5e16);
        {
            (, ISpotCLOB.OrderState memory buyState) = book.getOrder(rejectedRemainder);
            require(buyState.filledQuantity == 0, "dust ask unexpectedly filled the buy");
            require(
                buyState.status == ISpotCLOB.OrderStatus.Cancelled, "buy remainder was not closed"
            );
        }
        _assertUnlinked(book, rejectedRemainder);
        require(quote.balanceOf(address(buyer)) == MINIMUM_QUOTE, "buyer escrow was not refunded");
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
        uint128 makerQuantity = MINIMUM_AT_ONE_USDC + 1;
        uint128 fillQuantity = MINIMUM_AT_ONE_USDC;

        _fundBase(book, base, seller, makerQuantity);
        _fundQuote(book, quote, buyer, MINIMUM_QUOTE);
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
        require(quote.balanceOf(address(seller)) == MINIMUM_QUOTE, "maker proceeds changed");
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
        uint128 makerQuantity = MINIMUM_AT_ONE_USDC;
        uint128 takerQuantity = MINIMUM_AT_ONE_USDC + 1;

        _fundBase(book, base, seller, makerQuantity);
        _fundQuote(book, quote, buyer, MINIMUM_QUOTE);
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
        require(quote.balanceOf(address(buyer)) == 0, "taker quote debit changed");
        require(base.balanceOf(address(buyer)) == makerQuantity, "taker base payout changed");
        require(quote.balanceOf(address(seller)) == MINIMUM_QUOTE, "maker proceeds changed");
        (, uint256 buyerLocked,) = book.balanceOf(address(buyer), address(quote));
        require(buyerLocked == 0, "taker dust remains locked");
        _assertEmptyBook(book, poolId);
    }

    function testL01_ExactMinimumNotionalBoundaryFillsNormally() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();
        uint128 quantity = MINIMUM_AT_ONE_USDC;

        _fundBase(book, base, seller, quantity);
        _fundQuote(book, quote, buyer, MINIMUM_QUOTE);
        bytes32 ask = seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, quantity
        );
        bytes32 buy = buyer.place(
            book, address(base), address(quote), ISpotCLOB.Side.Buy, ONE_USDC_PER_TOKEN, quantity
        );

        (, ISpotCLOB.OrderState memory askState) = book.getOrder(ask);
        (, ISpotCLOB.OrderState memory buyState) = book.getOrder(buy);
        require(askState.status == ISpotCLOB.OrderStatus.Filled, "minimum maker not filled");
        require(buyState.status == ISpotCLOB.OrderStatus.Filled, "minimum taker not filled");
        require(quote.balanceOf(address(seller)) == MINIMUM_QUOTE, "minimum quote not settled");
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

    function testI01_MakerOrderCarriesFeeAcrossSplitFills() public {
        uint256 singleFillMakerProceeds = _legacyFeeScenario(false);
        uint256 splitFillMakerProceeds = _legacyFeeScenario(true);

        require(singleFillMakerProceeds == 9, "single fill maker fee changed");
        require(
            splitFillMakerProceeds == singleFillMakerProceeds,
            "splitting reduced the maker order's fee"
        );
    }

    function testI01_TakerOrderCarriesFeeAcrossMultipleMakers() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(0, 0, 1_000);
        AuditPricingActor sellerA = new AuditPricingActor();
        AuditPricingActor sellerB = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();

        _fundBase(book, base, sellerA, 5);
        _fundBase(book, base, sellerB, 5);
        _fundQuote(book, quote, buyer, 11);
        sellerA.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, 5
        );
        sellerB.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, 5
        );

        bytes32 bid = buyer.place(
            book, address(base), address(quote), ISpotCLOB.Side.Buy, ONE_USDC_PER_TOKEN, 10
        );

        require(book.accruedTradingFees(address(quote)) == 1, "taker fee was split by maker");
        require(book.orderFeeRemainder(bid) == 0, "taker remainder not consumed");
        require(quote.balanceOf(address(buyer)) == 0, "buyer did not pay aggregate taker fee");
    }

    function testI01_SubAtomFeeCarriesAcrossFillsOfSameOrder() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(0, 0, 1_000);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();

        _fundBase(book, base, seller, 10);
        _fundQuote(book, quote, buyer, 10);

        bytes32 ask = seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, 10
        );
        buyer.marketBuy(book, address(base), address(quote), 5, ONE_USDC_PER_TOKEN);

        require(book.accruedTradingFees(address(quote)) == 0, "sub-atom fee charged early");
        require(book.orderFeeRemainder(ask) == 5_000, "maker remainder not carried");

        buyer.marketBuy(book, address(base), address(quote), 5, ONE_USDC_PER_TOKEN);

        require(book.accruedTradingFees(address(quote)) == 1, "carried maker fee not charged");
        require(book.orderFeeRemainder(ask) == 0, "maker remainder not consumed");
        require(quote.balanceOf(address(seller)) == 9, "seller net proceeds incorrect");
        require(quote.balanceOf(address(buyer)) == 0, "buyer quote debit incorrect");
    }

    function testI01_CarriedFeeDoesNotUnderfundRestingBid() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(0, 0, 1_000);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();

        _fundBase(book, base, seller, 10);
        _fundQuote(book, quote, buyer, 11);
        bytes32 bid = buyer.place(
            book, address(base), address(quote), ISpotCLOB.Side.Buy, ONE_USDC_PER_TOKEN, 10
        );

        seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, 5
        );
        (, ISpotCLOB.OrderState memory partialState) = book.getOrder(bid);
        require(
            partialState.status == ISpotCLOB.OrderStatus.PartiallyFilled,
            "bid did not partially fill"
        );
        (, uint256 lockedAfterFirst,) = book.balanceOf(address(buyer), address(quote));
        require(lockedAfterFirst == 6, "bid released carried-fee reserve");

        seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, 5
        );
        (, ISpotCLOB.OrderState memory filled) = book.getOrder(bid);
        require(filled.status == ISpotCLOB.OrderStatus.Filled, "carried fee froze resting bid");
        (, uint256 lockedAfterSecond,) = book.balanceOf(address(buyer), address(quote));
        require(lockedAfterSecond == 0, "filled bid retained reserve");
        require(book.accruedTradingFees(address(quote)) == 1, "resting-bid fees incorrect");
        require(book.orderFeeRemainder(bid) == 0, "resting-bid remainder not consumed");
    }

    function testFuzz_I01MakerFeeIsInvariantToFillPartition(uint16 totalSeed, uint16 splitSeed)
        public
    {
        uint128 total = uint128(2 + totalSeed % 999);
        uint128 first = uint128(1 + splitSeed % (total - 1));
        uint128 second = total - first;
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(0, 0, 1_000);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor buyer = new AuditPricingActor();

        _fundBase(book, base, seller, total);
        _fundQuote(book, quote, buyer, uint256(total) + uint256(total) / 10 + 1);
        bytes32 ask = seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC_PER_TOKEN, total
        );
        buyer.marketBuy(book, address(base), address(quote), first, ONE_USDC_PER_TOKEN);
        buyer.marketBuy(book, address(base), address(quote), second, ONE_USDC_PER_TOKEN);

        uint256 expectedMakerFee = uint256(total) / 10;
        uint256 expectedTakerFees = uint256(first) / 10 + uint256(second) / 10;
        uint16 expectedRemainder = uint16((uint256(total) % 10) * 1_000);
        require(
            book.accruedTradingFees(address(quote)) == expectedMakerFee + expectedTakerFees,
            "partition changed aggregate fee"
        );
        require(book.orderFeeRemainder(ask) == expectedRemainder, "maker remainder mismatch");
        require(
            quote.balanceOf(address(seller)) == uint256(total) - expectedMakerFee,
            "maker proceeds depend on partition"
        );
    }

    function testAccepted_I02_ManyPartialFillsPayLessQuoteThanOneFill() public {
        uint256 singleFillProceeds = _partialAskScenario(false);
        uint256 fragmentedProceeds = _partialAskScenario(true);

        require(singleFillProceeds == 100_001, "single fill quote changed");
        require(fragmentedProceeds == 100_000, "partial-fill rounding was not reproduced");
        require(
            fragmentedProceeds < singleFillProceeds,
            "many fills did not pay less quote than one fill"
        );
    }

    function testI03_UnrepresentableMinimumRevertsExplicitly() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(59, 0, 0);
        SpotCLOBLens lens = new SpotCLOBLens();
        AuditPricingActor seller = new AuditPricingActor();

        uint128 maximumPriceMinimum =
            lens.minimumOrderQuantity(book, address(base), address(quote), type(uint128).max);
        require(
            lens.quoteAmount(
                book, address(base), address(quote), type(uint128).max, maximumPriceMinimum
            ) >= 1,
            "representable boundary was rejected"
        );

        (bool success, bytes memory reason) = address(lens)
            .staticcall(
                abi.encodeCall(
                    SpotCLOBLens.minimumOrderQuantity,
                    (book, address(base), address(quote), uint128(1))
                )
            );
        require(!success, "unrepresentable minimum was returned");
        require(
            keccak256(reason)
                == keccak256(
                    abi.encodeWithSelector(
                        SpotCLOBLens.MinimumQuantityUnrepresentable.selector, uint128(1)
                    )
                ),
            "wrong unrepresentable-minimum error"
        );

        _fundBase(book, base, seller, MAX_UINT128);
        require(
            !seller.attemptPlace(
                book, address(base), address(quote), ISpotCLOB.Side.Sell, 1, MAX_UINT128
            ),
            "unrepresentable minimum quantity was accepted"
        );
    }

    function testI05_MaxQuantityDoesNotSaturatePriceLevel() public {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote, bytes32 poolId) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor firstSeller = new AuditPricingActor();
        AuditPricingActor secondSeller = new AuditPricingActor();
        uint128 price = 1e30;

        _fundBase(book, base, firstSeller, MAX_UINT128);
        uint128 minimum = 100_000;
        _fundBase(book, base, secondSeller, minimum);
        bytes32 first = firstSeller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, price, MAX_UINT128
        );
        bytes32 second = secondSeller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, price, minimum
        );

        (uint256 levelQuantity, bytes32 head, bytes32 tail) =
            book.getPriceLevel(poolId, ISpotCLOB.Side.Sell, price);
        require(
            levelQuantity == uint256(MAX_UINT128) + minimum,
            "price-level aggregate did not exceed uint128"
        );
        require(head == first && tail == second, "wide level broke FIFO links");
    }

    function _legacyFeeScenario(bool split) private returns (uint256 makerProceeds) {
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
        AuditPricingActor buyer = new AuditPricingActor();
        _fundBase(book, base, sellerA, 10);
        _fundQuote(book, quote, buyer, 11);

        sellerA.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 1, 10);
        if (split) {
            buyer.marketBuy(book, address(base), address(quote), 5, 1);
            buyer.marketBuy(book, address(base), address(quote), 5, 1);
        } else {
            buyer.marketBuy(book, address(base), address(quote), 10, 1);
        }
        return quote.balanceOf(address(sellerA));
    }

    function _partialAskScenario(bool fragmented) private returns (uint256) {
        (SpotCLOB book, AuditPricingToken base, AuditPricingToken quote,) =
            _deployAgnostic(18, 6, 0);
        AuditPricingActor seller = new AuditPricingActor();
        AuditPricingActor firstBuyer = new AuditPricingActor();
        AuditPricingActor secondBuyer = new AuditPricingActor();
        uint128 totalQuantity = 100_001e12;
        uint128 partialQuantity = totalQuantity / 2;
        uint128 price = ONE_USDC_PER_TOKEN;

        _fundBase(book, base, seller, totalQuantity);
        _fundQuote(book, quote, firstBuyer, 100_001);
        _fundQuote(book, quote, secondBuyer, 100_001);
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
