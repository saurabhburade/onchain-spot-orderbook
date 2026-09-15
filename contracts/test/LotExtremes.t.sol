// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";

contract LotExtremesBuyer {
    function approve(MockERC20 token, SpotCLOB book) external {
        token.approve(address(book), type(uint256).max);
    }

    function marketBuy(
        SpotCLOB book,
        MockERC20 base,
        MockERC20 quote,
        uint128 quantity,
        uint128 priceLimit
    ) external returns (uint128 filledQuantity, uint256 quoteQuantity) {
        (, filledQuantity, quoteQuantity) = book.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: address(this),
                baseAsset: address(base),
                quoteAsset: address(quote),
                side: ISpotCLOB.Side.Buy,
                quantity: quantity,
                priceLimit: priceLimit,
                minFillQuantity: quantity,
                clientOrderId: 1
            }),
            64
        );
    }
}

contract LotExtremesTest {
    uint24 private constant MAX_TICK = type(uint24).max;
    uint256 private constant BASE_SCALE = 1e18;
    uint256 private constant QUOTE_SCALE = 1e6;
    uint256 private constant PRICE_SCALE = 1e18;

    function testTokenPriceCanReachOneHundredBillionthUsdcWithOneAtomMinimumOrder() public {
        uint128 lotSize = 100_000e18; // 100,000 tokens per lot.
        uint128 lotPrice = 1; // 0.000001 USDC per lot = 0.00000000001 per token.
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarketWithLotSize(18, lotSize);

        _placeAsk(base, quote, book, lotSize, lotPrice);
        LotExtremesBuyer buyer = _fundBuyer(quote, book, lotPrice);
        (uint128 filled, uint256 quoteFilled) = buyer.marketBuy(book, base, quote, 1, lotPrice);

        require(filled == 1 && quoteFilled == 1, "minimum-notional fill changed");
        require(base.balanceOf(address(buyer)) == lotSize, "buyer received wrong base amount");
        require(quote.balanceOf(address(this)) == 1, "seller received wrong quote amount");
        require(
            uint256(lotPrice) * 1e30 / lotSize == 1e7, "per-token price is not 0.00000000001 USDC"
        );
    }

    function testOneMillionthUsdcTokenPriceRequiresOneTokenMinimumOrder() public {
        _assertOneAtomTrade({ lotSize: 1e18, expectedPriceWad: 1e12 });
    }

    function testOneUsdcTokenPriceRequiresOneMillionthTokenMinimumOrder() public {
        _assertOneAtomTrade({ lotSize: 1e12, expectedPriceWad: 1e18 });
    }

    function testTenUsdcTokenPriceRequiresOneTenMillionthTokenMinimumOrder() public {
        _assertOneAtomTrade({ lotSize: 1e11, expectedPriceWad: 10e18 });
    }

    function testMinimumQuantityRegressionForEveryRequiredTokenPrice() public pure {
        _assertExactMinimumQuantity(1e7, 100_000e18); // 0.00000000001 USDC/token.
        _assertExactMinimumQuantity(1e12, 1e18); // 0.000001 USDC/token.
        _assertExactMinimumQuantity(1e18, 1e12); // 1 USDC/token.
        _assertExactMinimumQuantity(10e18, 1e11); // 10 USDC/token.
    }

    function testOneUsdcAtomBuysOneHundredBillionthDemoToken() public {
        uint128 lotSize = 1e7; // 0.00000000001 of an 18-decimal token.
        uint128 lotPrice = 1; // One 6-decimal USDC atom = 0.000001 USDC.
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarket(18, 11);

        _placeAsk(base, quote, book, lotSize, lotPrice);
        LotExtremesBuyer buyer = _fundBuyer(quote, book, lotPrice);
        (uint128 filled, uint256 quoteFilled) = buyer.marketBuy(book, base, quote, 1, lotPrice);

        require(filled == 1 && quoteFilled == 1, "wrong one-atom fill");
        require(base.balanceOf(address(buyer)) == lotSize, "buyer received wrong base amount");
        require(quote.balanceOf(address(this)) == 1, "seller received wrong quote amount");
    }

    function testSubAtomUsdcDustCannotBecomeRestingPrice() public {
        // 0.00000001 USDC expressed at 18-decimal precision becomes zero native USDC atoms.
        uint256 dustUsdcX18 = 1e10;
        uint256 dustUsdcAtoms = dustUsdcX18 * 1e6 / 1e18;
        require(dustUsdcAtoms == 0, "dust unexpectedly representable");

        uint128 lotSize = 1e7; // 0.00000000001 of an 18-decimal token.
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarket(18, 11);
        base.mint(address(this), lotSize);
        base.approve(address(book), lotSize);

        ISpotCLOB.LimitOrder memory dustAsk = ISpotCLOB.LimitOrder({
            trader: address(this),
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: ISpotCLOB.Side.Sell,
            price: 0,
            quantity: 1,
            expiry: 0,
            clientOrderId: 1
        });
        (bool success,) = address(book).call(abi.encodeCall(SpotCLOB.placeLimitOrder, (dustAsk)));

        require(!success, "sub-atom USDC ask was accepted");
        require(base.balanceOf(address(this)) == lotSize, "failed dust ask moved base tokens");
    }

    function testOneUsdcBuysOneHundredBillionthDemoToken() public {
        uint128 lotSize = 1e7; // 0.00000000001 of an 18-decimal token.
        uint128 lotPrice = 1e6; // 1 USDC in quote-token atoms.
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarket(18, 11);

        _placeAsk(base, quote, book, lotSize, lotPrice);
        LotExtremesBuyer buyer = _fundBuyer(quote, book, lotPrice);
        (uint128 filled, uint256 quoteFilled) = buyer.marketBuy(book, base, quote, 1, lotPrice);

        require(filled == 1 && quoteFilled == 1e6, "wrong one-USDC fill");
        require(base.balanceOf(address(buyer)) == lotSize, "buyer received wrong base amount");
        require(quote.balanceOf(address(this)) == 999_000, "seller received wrong quote amount");
    }

    function testExpensiveTokenSupportsOneTenMillionthTokenLot() public {
        uint128 lotSize = 1e11; // 0.0000001 of an 18-decimal token.
        uint128 lotPrice = 10_000; // 0.01 USDC per lot = 100,000 USDC per token.
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarket(18, 7);

        _placeAsk(base, quote, book, lotSize, lotPrice);

        (,,, bool askExists, uint128 bestAsk, uint128 askQuantity) =
            book.getBestPrices(book.marketId(address(base), address(quote)));
        require(askExists, "fractional-lot ask missing");
        require(bestAsk == lotPrice && askQuantity == 1, "fractional-lot ask changed");
        require(uint256(bestAsk) * 1e18 / lotSize / 1e6 == 100_000, "wrong token price");
    }

    function test24DecimalTokenSupportsEightDecimalLot() public {
        uint128 lotSize = 1e16; // 0.00000001 of a 24-decimal token.
        uint128 lotPrice = 5; // 0.000005 USDC per lot = 500 USDC per token.
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarket(24, 8);

        _placeAsk(base, quote, book, lotSize, lotPrice);

        (,,, bool askExists, uint128 bestAsk, uint128 askQuantity) =
            book.getBestPrices(book.marketId(address(base), address(quote)));
        require(askExists, "billion-token ask missing");
        require(bestAsk == lotPrice && askQuantity == 1, "billion-token ask changed");
        require(uint256(bestAsk) * 1e24 / lotSize / 1e6 == 500, "wrong token price");
    }

    function _createMarket(uint8 baseDecimals, uint8 lotDecimals)
        private
        returns (MockERC20 base, MockERC20 quote, SpotCLOB book)
    {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        base = new MockERC20("Base Token", "BASE", baseDecimals);
        quote = new MockERC20("USD Coin", "USDC", 6);
        factory.setQuoteToken(address(quote), true);
        factory.setPairLotDecimals(address(base), address(quote), lotDecimals);
        (, address bookAddress) = factory.createPair(address(base), address(quote), 1, 1, MAX_TICK);
        book = SpotCLOB(bookAddress);
    }

    function _createMarketWithLotSize(uint8 baseDecimals, uint128 lotSize)
        private
        returns (MockERC20 base, MockERC20 quote, SpotCLOB book)
    {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        base = new MockERC20("Base Token", "BASE", baseDecimals);
        quote = new MockERC20("USD Coin", "USDC", 6);
        factory.setQuoteToken(address(quote), true);
        (, address bookAddress) =
            factory.createPair(address(base), address(quote), lotSize, 1, 1, MAX_TICK);
        book = SpotCLOB(bookAddress);
    }

    function _placeAsk(
        MockERC20 base,
        MockERC20 quote,
        SpotCLOB book,
        uint128 lotSize,
        uint128 price
    ) private {
        base.mint(address(this), lotSize);
        base.approve(address(book), lotSize);
        book.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: address(base),
                quoteAsset: address(quote),
                side: ISpotCLOB.Side.Sell,
                price: price,
                quantity: 1,
                expiry: 0,
                clientOrderId: 1
            })
        );
    }

    function _fundBuyer(MockERC20 quote, SpotCLOB book, uint256 amount)
        private
        returns (LotExtremesBuyer buyer)
    {
        buyer = new LotExtremesBuyer();
        uint256 takerFee = amount * 10 / 10_000;
        quote.mint(address(buyer), amount + takerFee);
        buyer.approve(quote, book);
    }

    function _assertOneAtomTrade(uint128 lotSize, uint256 expectedPriceWad) private {
        uint128 lotPrice = 1;
        (MockERC20 base, MockERC20 quote, SpotCLOB book) = _createMarketWithLotSize(18, lotSize);

        _placeAsk(base, quote, book, lotSize, lotPrice);
        LotExtremesBuyer buyer = _fundBuyer(quote, book, lotPrice);
        (uint128 filled, uint256 quoteFilled) = buyer.marketBuy(book, base, quote, 1, lotPrice);

        require(filled == 1 && quoteFilled == 1, "minimum-notional fill changed");
        require(base.balanceOf(address(buyer)) == lotSize, "buyer received wrong base amount");
        require(quote.balanceOf(address(this)) == 1, "seller received wrong quote amount");
        require(_priceWad(lotSize) == expectedPriceWad, "per-token price changed");
    }

    function _assertExactMinimumQuantity(uint256 priceWad, uint256 expectedBaseRaw) private pure {
        uint256 minimumBaseRaw = _minimumBaseRawForOneQuoteAtom(priceWad);

        require(minimumBaseRaw == expectedBaseRaw, "minimum base quantity changed");
        require(_quoteAtoms(priceWad, minimumBaseRaw) == 1, "minimum does not settle one atom");
        require(
            _quoteAtoms(priceWad, minimumBaseRaw - 1) == 0,
            "smaller quantity unexpectedly meets minimum"
        );
    }

    function _minimumBaseRawForOneQuoteAtom(uint256 priceWad) private pure returns (uint256) {
        uint256 numerator = PRICE_SCALE * BASE_SCALE;
        uint256 denominator = priceWad * QUOTE_SCALE;
        return (numerator + denominator - 1) / denominator;
    }

    function _quoteAtoms(uint256 priceWad, uint256 baseRaw) private pure returns (uint256) {
        return priceWad * baseRaw * QUOTE_SCALE / (PRICE_SCALE * BASE_SCALE);
    }

    function _priceWad(uint256 baseRawPerLot) private pure returns (uint256) {
        return PRICE_SCALE * BASE_SCALE / (QUOTE_SCALE * baseRawPerLot);
    }
}
