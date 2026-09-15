// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolRegistry } from "../src/IPoolRegistry.sol";
import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

contract AgnosticToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

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

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AgnosticTrader {
    function approve(AgnosticToken token, SpotCLOB exchange) external {
        token.approve(address(exchange), type(uint256).max);
    }

    function place(
        SpotCLOB exchange,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
    ) external returns (bytes32) {
        return exchange.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                price: price,
                quantity: quantity,
                expiry: 0,
                clientOrderId: 0
            })
        );
    }

    function attemptPlace(
        SpotCLOB exchange,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
    ) external returns (bool success) {
        ISpotCLOB.LimitOrder memory order = ISpotCLOB.LimitOrder({
            trader: address(this),
            baseAsset: base,
            quoteAsset: quote,
            side: side,
            price: price,
            quantity: quantity,
            expiry: 0,
            clientOrderId: 0
        });
        (success,) = address(exchange).call(abi.encodeCall(SpotCLOB.placeLimitOrder, (order)));
    }

    function marketBuy(SpotCLOB exchange, address base, address quote, uint128 quantity)
        external
        returns (uint128 filled, uint256 quoteQuantity)
    {
        (, filled, quoteQuantity) = exchange.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: ISpotCLOB.Side.Buy,
                quantity: quantity,
                priceLimit: 0,
                minFillQuantity: quantity,
                clientOrderId: 0
            }),
            64
        );
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }
}

contract AgnosticPricingTest {
    uint128 private constant LOW_PRICE = 1e7; // 0.00000000001 USDC/token
    uint128 private constant ONE_USDC = 1e18;
    uint128 private constant HIGH_PRICE = 1e24; // 1,000,000 USDC/token
    uint128 private constant LOW_MIN_QUANTITY = 100_000 ether;
    uint128 private constant HIGH_MIN_QUANTITY = 1e6; // 0.000000000001 token

    SpotCLOBFactory private factory;
    SpotCLOB private exchange;
    AgnosticToken private base;
    AgnosticToken private quote;
    AgnosticTrader private seller;
    AgnosticTrader private buyer;
    SpotCLOBLens private lens;
    bytes32 private poolId;

    function setUp() public {
        factory = new SpotCLOBFactory();
        base = new AgnosticToken(18);
        quote = new AgnosticToken(6);
        factory.setQuoteToken(address(quote), true);
        address book;
        (poolId, book) = factory.createPair(address(base), address(quote));
        exchange = SpotCLOB(book);
        lens = new SpotCLOBLens();

        seller = new AgnosticTrader();
        buyer = new AgnosticTrader();
        base.mint(address(seller), 2_000_000_000_000 ether);
        quote.mint(address(buyer), 200_000_000 * 1e6);
        seller.approve(base, exchange);
        buyer.approve(quote, exchange);
    }

    function testCreationUsesOneAgnosticRangeAndTokenDecimals() public view {
        IPoolRegistry.Pool memory pool = factory.getPool(poolId);
        require(pool.agnosticPricing, "not agnostic");
        require(pool.baseDecimals == 18 && pool.quoteDecimals == 6, "wrong decimals");
        require(pool.lotSize == 0 && pool.tickSize == 0, "legacy sizing enabled");

        SpotCLOB.Market memory market = exchange.getMarket(address(base), address(quote));
        require(market.agnosticPricing && market.enabled, "market not active");
        require(
            lens.minimumOrderQuantity(exchange, address(base), address(quote), LOW_PRICE)
                == LOW_MIN_QUANTITY,
            "wrong low-price minimum"
        );
        require(
            lens.minimumOrderQuantity(exchange, address(base), address(quote), HIGH_PRICE)
                == HIGH_MIN_QUANTITY,
            "wrong high-price minimum"
        );
    }

    function testSameBookTraversesElevenDecimalPriceAndMillionDollarPrice() public {
        bytes32 low = seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            LOW_PRICE,
            LOW_MIN_QUANTITY
        );
        bytes32 high = seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            HIGH_PRICE,
            HIGH_MIN_QUANTITY
        );

        (,,,, uint128 bestAsk,) = exchange.getBestPrices(poolId);
        require(bestAsk == LOW_PRICE, "wrong best ask");
        (, ISpotCLOB.PriceLevelView[] memory asks) = exchange.getOrderBook(poolId, 2);
        require(asks.length == 2, "missing price levels");
        require(asks[0].price == LOW_PRICE && asks[1].price == HIGH_PRICE, "wrong traversal");

        seller.cancel(exchange, low);
        (,,,, bestAsk,) = exchange.getBestPrices(poolId);
        require(bestAsk == HIGH_PRICE, "high price unreachable");
        seller.cancel(exchange, high);
    }

    function testLowPriceMinimumTradeSettlesOneUsdcAtom() public {
        seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            LOW_PRICE,
            LOW_MIN_QUANTITY
        );
        (uint128 filled, uint256 paid) =
            buyer.marketBuy(exchange, address(base), address(quote), LOW_MIN_QUANTITY);

        require(filled == LOW_MIN_QUANTITY && paid == 1, "wrong low-price fill");
        require(base.balanceOf(address(buyer)) == LOW_MIN_QUANTITY, "buyer base mismatch");
        require(quote.balanceOf(address(seller)) == 1, "seller quote mismatch");
    }

    function testMillionDollarPriceTradesOneTrillionthOfTokenForOneAtom() public {
        seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            HIGH_PRICE,
            HIGH_MIN_QUANTITY
        );
        (uint128 filled, uint256 paid) =
            buyer.marketBuy(exchange, address(base), address(quote), HIGH_MIN_QUANTITY);

        require(filled == HIGH_MIN_QUANTITY && paid == 1, "wrong high-price fill");
        require(base.balanceOf(address(buyer)) == HIGH_MIN_QUANTITY, "buyer base mismatch");
        require(quote.balanceOf(address(seller)) == 1, "seller quote mismatch");
    }

    function testHundredTokenSupplyCanTradeAtOneMillionDollarsEach() public {
        uint128 quantity = 100 ether;
        seller.place(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, HIGH_PRICE, quantity
        );
        (uint128 filled, uint256 paid) =
            buyer.marketBuy(exchange, address(base), address(quote), quantity);

        require(filled == quantity, "not fully filled");
        require(paid == 100_000_000 * 1e6, "wrong notional");
    }

    function testRejectsOrdersBelowOneQuoteAtomAtEveryRegressionPrice() public {
        _assertMinimum(LOW_PRICE, 100_000 ether);
        _assertMinimum(1e12, 1 ether); // 0.000001 USDC/token
        _assertMinimum(ONE_USDC, 1e12); // 0.000001 token
        _assertMinimum(10e18, 1e11); // 0.0000001 token
        _assertMinimum(HIGH_PRICE, HIGH_MIN_QUANTITY);
    }

    function testPartialFillCancelsAndRefundsUnsettleableDust() public {
        uint128 quantity = LOW_MIN_QUANTITY + 1;
        bytes32 maker = seller.place(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, LOW_PRICE, quantity
        );
        buyer.marketBuy(exchange, address(base), address(quote), LOW_MIN_QUANTITY);

        (, ISpotCLOB.OrderState memory state) = exchange.getOrder(maker);
        require(state.status == ISpotCLOB.OrderStatus.Cancelled, "dust still resting");
        require(state.filledQuantity == LOW_MIN_QUANTITY, "wrong fill amount");
        require(
            base.balanceOf(address(seller)) == 2_000_000_000_000 ether - LOW_MIN_QUANTITY,
            "dust not refunded"
        );
        require(
            !exchange.isPriceLevelActive(poolId, ISpotCLOB.Side.Sell, LOW_PRICE), "level active"
        );
    }

    function testConfigurableFeeStillAccruesOnlyInQuoteToken() public {
        factory.setPairTradingFeeBps(address(base), address(quote), 10);
        uint128 quantity = 1_000 ether;
        seller.place(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, ONE_USDC, quantity
        );
        buyer.marketBuy(exchange, address(base), address(quote), quantity);

        require(exchange.accruedTradingFees(address(quote)) == 2e6, "wrong quote fee");
        require(exchange.accruedTradingFees(address(base)) == 0, "base fee accrued");
    }

    function _assertMinimum(uint128 price, uint128 expected) private {
        uint128 minimum = lens.minimumOrderQuantity(exchange, address(base), address(quote), price);
        require(minimum == expected, "wrong minimum quantity");
        require(
            lens.quoteAmount(exchange, address(base), address(quote), price, minimum) >= 1,
            "minimum does not settle"
        );
        require(
            !seller.attemptPlace(
                exchange, address(base), address(quote), ISpotCLOB.Side.Sell, price, minimum - 1
            ),
            "sub-atom order accepted"
        );
    }
}
