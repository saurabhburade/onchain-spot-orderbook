// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolRegistry } from "../src/IPoolRegistry.sol";
import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

interface SpotCLOBTestVm {
    function warp(uint256 timestamp) external;
}

contract MockERC20 {
    string public name;
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    constructor(string memory name_) {
        name = name_;
    }

    function decimals() external pure returns (uint8) {
        return 18;
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

contract TraderActor {
    function deployBook(address registry_) external returns (SpotCLOB) {
        return new SpotCLOB(SpotCLOBFactory(registry_));
    }

    function activate(SpotCLOB exchange, bytes32 id) external {
        exchange.activatePool(id);
    }

    function attemptActivate(SpotCLOB exchange, bytes32 id) external returns (bool success) {
        (success,) = address(exchange).call(abi.encodeCall(SpotCLOB.activatePool, (id)));
    }

    function approve(MockERC20 token, SpotCLOB exchange) external {
        token.approve(address(exchange), type(uint256).max);
    }

    function place(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId
    ) external returns (bytes32) {
        return exchange.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                price: price,
                quantity: quantity,
                expiry: 0,
                clientOrderId: clientOrderId
            })
        );
    }

    function placeWithExpiry(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 expiry
    ) external returns (bytes32) {
        return exchange.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                price: price,
                quantity: quantity,
                expiry: expiry,
                clientOrderId: 0
            })
        );
    }

    function attemptPlaceWithZeroSteps(
        SpotCLOB exchange,
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
            expiry: 0,
            clientOrderId: 0
        });
        (success,) = address(exchange)
            .call(abi.encodeCall(SpotCLOB.placeLimitOrderWithMaxBookSteps, (order, uint32(0))));
    }

    function attemptPlace(
        SpotCLOB exchange,
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
            expiry: 0,
            clientOrderId: 0
        });
        (success,) = address(exchange).call(abi.encodeCall(SpotCLOB.placeLimitOrder, (order)));
    }

    function executeMarket(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint128 priceLimit,
        uint128 minFillQuantity,
        uint64 clientOrderId
    ) external returns (bytes32 orderId, uint128 filledQuantity, uint256 quoteQuantity) {
        return exchange.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                quantity: quantity,
                priceLimit: priceLimit,
                minFillQuantity: minFillQuantity,
                clientOrderId: clientOrderId
            }),
            64
        );
    }

    function attemptMarket(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint128 priceLimit,
        uint128 minFillQuantity
    ) external returns (bool success) {
        ISpotCLOB.MarketOrder memory order = ISpotCLOB.MarketOrder({
            trader: address(this),
            baseAsset: baseAsset,
            quoteAsset: quoteAsset,
            side: side,
            quantity: quantity,
            priceLimit: priceLimit,
            minFillQuantity: minFillQuantity,
            clientOrderId: 0
        });
        (success,) = address(exchange)
            .call(abi.encodeCall(SpotCLOB.executeMarketOrder, (order, uint32(64))));
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }

    function attemptCancel(SpotCLOB exchange, bytes32 orderId) external returns (bool success) {
        (success,) = address(exchange).call(abi.encodeCall(SpotCLOB.cancelOrder, (orderId)));
    }

    function attemptWithdrawTradingFees(
        SpotCLOB exchange,
        address asset,
        address recipient,
        uint256 amount
    ) external returns (bool success) {
        (success,) = address(exchange)
            .call(abi.encodeCall(SpotCLOB.withdrawTradingFees, (asset, recipient, amount)));
    }
}

contract SpotCLOBTest {
    uint128 private constant LOT_SIZE = 1 ether;
    address private constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    SpotCLOBTestVm private constant vm = SpotCLOBTestVm(VM_ADDRESS);

    SpotCLOB private exchange;
    SpotCLOBFactory private registry;
    MockERC20 private base;
    MockERC20 private quote;
    TraderActor private sellerA;
    TraderActor private sellerB;
    TraderActor private buyer;
    bytes32 private poolId;
    SpotCLOBLens private lens;

    function setUp() public {
        registry = new SpotCLOBFactory();
        MockERC20 tokenA = new MockERC20("TOKEN_A");
        MockERC20 tokenB = new MockERC20("TOKEN_B");
        (base, quote) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
        registry.setQuoteToken(address(quote), true);
        registry.setPairLotDecimals(address(base), address(quote), 0);
        address book;
        (poolId, book) = registry.createPair(address(base), address(quote), 1, 1, 100_000);
        exchange = SpotCLOB(book);
        lens = new SpotCLOBLens();
        sellerA = new TraderActor();
        sellerB = new TraderActor();
        buyer = new TraderActor();

        base.mint(address(sellerA), 100 ether);
        base.mint(address(sellerB), 100 ether);
        quote.mint(address(buyer), 1_000_000);

        sellerA.approve(base, exchange);
        sellerB.approve(base, exchange);
        buyer.approve(quote, exchange);
    }

    function testMatchesBestAskAndRefundsBuyPriceImprovement() public {
        bytes32 askAt100 = _place(sellerA, ISpotCLOB.Side.Sell, 100, 2, 1);
        bytes32 askAt90 = _place(sellerB, ISpotCLOB.Side.Sell, 90, 3, 2);
        bytes32 buyAt100 = _place(buyer, ISpotCLOB.Side.Buy, 100, 4, 3);

        _assertOrder(askAt90, 3, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(askAt100, 1, ISpotCLOB.OrderStatus.PartiallyFilled);
        _assertOrder(buyAt100, 4, ISpotCLOB.OrderStatus.Filled);

        (bool bidExists,,, bool askExists, uint128 askPrice, uint128 askQuantity) =
            exchange.getBestPrices(poolId);
        require(!bidExists, "unexpected bid");
        require(askExists && askPrice == 100 && askQuantity == 1, "wrong best ask");

        _assertBalance(address(buyer), address(quote), 999_630, 0);
        _assertBalance(address(buyer), address(base), 4 ether, 0);
        _assertBalance(address(sellerA), address(base), 98 ether, 1 ether);
        _assertBalance(address(sellerA), address(quote), 100, 0);
        _assertBalance(address(sellerB), address(quote), 270, 0);
    }

    function testSamePriceOrdersRemainFIFOAndCancellationIsAuthorized() public {
        bytes32 first = _place(sellerA, ISpotCLOB.Side.Sell, 200, 1, 1);
        bytes32 second = _place(sellerB, ISpotCLOB.Side.Sell, 200, 1, 2);

        require(!buyer.attemptCancel(exchange, second), "unauthorized cancellation succeeded");
        _place(buyer, ISpotCLOB.Side.Buy, 200, 1, 3);

        _assertOrder(first, 1, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(second, 0, ISpotCLOB.OrderStatus.Open);

        sellerB.cancel(exchange, second);
        _assertOrder(second, 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertBalance(address(sellerB), address(base), 100 ether, 0);
    }

    function testHierarchicalBitmapTraversesLeafAndRootBoundaries() public {
        bytes32 lowAsk = _place(sellerA, ISpotCLOB.Side.Sell, 1, 1, 1);
        bytes32 middleAsk = _place(sellerA, ISpotCLOB.Side.Sell, 300, 1, 2);
        bytes32 highAsk = _place(sellerA, ISpotCLOB.Side.Sell, 70_000, 1, 3);

        _assertBestAsk(1);
        sellerA.cancel(exchange, lowAsk);
        _assertBestAsk(300);
        sellerA.cancel(exchange, middleAsk);
        _assertBestAsk(70_000);
        sellerA.cancel(exchange, highAsk);

        (,,, bool askExists,,) = exchange.getBestPrices(poolId);
        require(!askExists, "ask bitmap did not empty");

        bytes32 lowBid = _place(buyer, ISpotCLOB.Side.Buy, 1, 1, 4);
        bytes32 middleBid = _place(buyer, ISpotCLOB.Side.Buy, 300, 1, 5);
        bytes32 highBid = _place(buyer, ISpotCLOB.Side.Buy, 70_000, 1, 6);

        _assertBestBid(70_000);
        buyer.cancel(exchange, highBid);
        _assertBestBid(300);
        buyer.cancel(exchange, middleBid);
        _assertBestBid(1);
        buyer.cancel(exchange, lowBid);

        (bool bidExists,,,,,) = exchange.getBestPrices(poolId);
        require(!bidExists, "bid bitmap did not empty");
    }

    function testBookStepLimitRevertsAtomically() public {
        bytes32 ask = _place(sellerA, ISpotCLOB.Side.Sell, 100, 1, 1);
        require(
            !buyer.attemptPlaceWithZeroSteps(
                exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1
            ),
            "crossing order ignored step limit"
        );

        _assertOrder(ask, 0, ISpotCLOB.OrderStatus.Open);
        _assertBalance(address(buyer), address(quote), 1_000_000, 0);
        _assertBestAsk(100);
    }

    function testCancelReturnsUnusedEscrowDirectlyToWallet() public {
        bytes32 orderId = _place(sellerA, ISpotCLOB.Side.Sell, 100, 2, 1);
        _assertBalance(address(sellerA), address(base), 98 ether, 2 ether);

        sellerA.cancel(exchange, orderId);

        _assertBalance(address(sellerA), address(base), 100 ether, 0);
        require(base.balanceOf(address(exchange)) == 0, "cancelled escrow stayed in contract");
    }

    function testOrderPullsFromWalletAndFullFillPaysWalletsDirectly() public {
        _place(sellerA, ISpotCLOB.Side.Sell, 100, 1, 1);
        _place(buyer, ISpotCLOB.Side.Buy, 120, 1, 2);

        _assertBalance(address(buyer), address(quote), 999_900, 0);
        _assertBalance(address(buyer), address(base), 1 ether, 0);
        _assertBalance(address(sellerA), address(base), 99 ether, 0);
        _assertBalance(address(sellerA), address(quote), 100, 0);
        require(base.balanceOf(address(exchange)) == 0, "filled base remained in contract");
        require(quote.balanceOf(address(exchange)) == 0, "filled quote remained in contract");
    }

    function testMarketBuyChargesTenBasisPointTakerFeeAndOwnerWithdraws() public {
        _place(sellerA, ISpotCLOB.Side.Sell, 10_000, 1, 1);

        buyer.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 1, 10_000, 1, 2
        );

        require(
            exchange.getMarket(address(base), address(quote)).tradingFeeBps == 10, "wrong fee rate"
        );
        require(exchange.feeRecipient() == address(this), "wrong fee recipient");
        require(exchange.accruedTradingFees(address(quote)) == 20, "wrong accrued fee");
        require(quote.balanceOf(address(buyer)) == 989_990, "buyer fee was not charged");
        require(quote.balanceOf(address(sellerA)) == 9_990, "maker fee was not charged");
        require(quote.balanceOf(address(exchange)) == 20, "fees were not retained");
        require(
            !sellerA.attemptWithdrawTradingFees(
                exchange, address(quote), address(sellerA), uint256(20)
            ),
            "non-recipient withdrew fees"
        );

        exchange.withdrawTradingFees(address(quote), address(sellerB), 20);
        require(exchange.accruedTradingFees(address(quote)) == 0, "fee was not cleared");
        require(quote.balanceOf(address(sellerB)) == 20, "fee recipient was not paid");
        require(quote.balanceOf(address(exchange)) == 0, "withdrawn fee stayed in book");
    }

    function testMarketSellChargesFeeFromTakerProceeds() public {
        _place(buyer, ISpotCLOB.Side.Buy, 20_000, 1, 1);

        sellerA.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, 1, 20_000, 1, 2
        );

        require(exchange.accruedTradingFees(address(quote)) == 40, "wrong sell fee");
        require(quote.balanceOf(address(sellerA)) == 19_980, "seller fee was not withheld");
        require(quote.balanceOf(address(exchange)) == 40, "sell fees were not retained");
    }

    function testCrossingLimitSellChargesMakerAndTakerFeesInQuote() public {
        _place(buyer, ISpotCLOB.Side.Buy, 20_000, 1, 1);
        _place(sellerA, ISpotCLOB.Side.Sell, 20_000, 1, 2);

        require(exchange.accruedTradingFees(address(quote)) == 40, "wrong limit fees");
        require(quote.balanceOf(address(sellerA)) == 19_980, "seller fee was not withheld");
        require(base.balanceOf(address(buyer)) == 1 ether, "maker did not receive base");
        require(quote.balanceOf(address(exchange)) == 40, "limit fees were not retained");
    }

    function testRestingBuyKeepsFeeReserveUntilCancellation() public {
        bytes32 buy = _place(buyer, ISpotCLOB.Side.Buy, 20_000, 1, 1);

        _assertBalance(address(buyer), address(quote), 979_980, 20_020);
        buyer.cancel(exchange, buy);
        _assertBalance(address(buyer), address(quote), 1_000_000, 0);
        require(quote.balanceOf(address(exchange)) == 0, "cancelled reserve stayed in book");
    }

    function testAdminFeeUpdateAppliesToSubsequentFills() public {
        registry.setPairTradingFeeBps(address(base), address(quote), 20);
        _place(sellerA, ISpotCLOB.Side.Sell, 20_000, 1, 1);

        buyer.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 1, 20_000, 1, 2
        );

        require(exchange.accruedTradingFees(address(quote)) == 80, "updated fees not accrued");
        require(quote.balanceOf(address(buyer)) == 979_960, "updated taker fee was not charged");
        require(quote.balanceOf(address(sellerA)) == 19_960, "updated maker fee was not charged");
    }

    function testCrossingLimitBuyReleasesUnusedFeeReserveBeforeResting() public {
        _place(sellerA, ISpotCLOB.Side.Sell, 9_000, 1, 1);
        bytes32 buy = _place(buyer, ISpotCLOB.Side.Buy, 10_000, 2, 2);

        _assertOrder(buy, 1, ISpotCLOB.OrderStatus.PartiallyFilled);
        _assertBalance(address(buyer), address(quote), 980_981, 10_010);
        require(exchange.accruedTradingFees(address(quote)) == 18, "wrong crossing fees");
        require(quote.balanceOf(address(exchange)) == 10_028, "fee reserve was not retained");

        buyer.cancel(exchange, buy);
        _assertBalance(address(buyer), address(quote), 990_991, 0);
        require(quote.balanceOf(address(exchange)) == 18, "cancel disturbed accrued fees");
    }

    function testOneAtomDustTradeRemainsValidAndFeeRoundsDown() public {
        _place(sellerA, ISpotCLOB.Side.Sell, 1, 1, 1);
        buyer.executeMarket(exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 1, 1, 1, 2);

        require(exchange.accruedTradingFees(address(quote)) == 0, "dust fee did not round down");
        require(quote.balanceOf(address(sellerA)) == 1, "dust maker was not paid");
    }

    function testOrderWithoutAllowanceRevertsBeforeChangingBook() public {
        TraderActor unapprovedBuyer = new TraderActor();
        quote.mint(address(unapprovedBuyer), 1_000);

        require(
            !unapprovedBuyer.attemptPlace(
                exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1
            ),
            "order without allowance succeeded"
        );
        _assertBalance(address(unapprovedBuyer), address(quote), 1_000, 0);
        (bool bidExists,,,,,) = exchange.getBestPrices(poolId);
        require(!bidExists, "failed order changed the book");
    }

    function testMarketBuyConsumesMultipleLevelsAndFinalPartialLevel() public {
        _place(sellerA, ISpotCLOB.Side.Sell, 100, 2, 1);
        bytes32 secondAsk = _place(sellerB, ISpotCLOB.Side.Sell, 110, 3, 2);

        (bytes32 marketOrder, uint128 filled, uint256 quoteFilled) = buyer.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 4, 110, 4, 3
        );

        require(filled == 4 && quoteFilled == 420, "wrong market-buy result");
        _assertOrder(marketOrder, 4, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(secondAsk, 2, ISpotCLOB.OrderStatus.PartiallyFilled);
        _assertBestAsk(110);
        _assertBalance(address(buyer), address(quote), 999_580, 0);
        _assertBalance(address(buyer), address(base), 4 ether, 0);
    }

    function testMarketOrderMinimumFillRevertsAtomicallyThenAllowsExplicitPartial() public {
        bytes32 ask = _place(sellerA, ISpotCLOB.Side.Sell, 100, 2, 1);

        require(
            !buyer.attemptMarket(
                exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 3, 100, 3
            ),
            "minimum fill was ignored"
        );
        _assertOrder(ask, 0, ISpotCLOB.OrderStatus.Open);
        _assertBalance(address(buyer), address(quote), 1_000_000, 0);

        (bytes32 marketOrder, uint128 filled, uint256 quoteFilled) = buyer.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 3, 100, 0, 2
        );
        require(filled == 2 && quoteFilled == 200, "wrong partial market result");
        _assertOrder(marketOrder, 2, ISpotCLOB.OrderStatus.PartiallyFilled);
        (,, bool resting) = exchange.getOrderLinks(marketOrder);
        require(!resting, "market remainder became resting liquidity");
        require(!buyer.attemptCancel(exchange, marketOrder), "non-resting remainder cancelled");
        _assertBalance(address(buyer), address(quote), 999_800, 0);

        (,,, bool askExists,,) = exchange.getBestPrices(poolId);
        require(!askExists, "depleted ask remained active");
    }

    function testMarketOrderOnEmptyBookRevertsAtomically() public {
        require(
            !buyer.attemptMarket(
                exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 5, 100, 0
            ),
            "empty market order succeeded"
        );
        _assertBalance(address(buyer), address(quote), 1_000_000, 0);
        (bool bidExists,,, bool askExists,,) = exchange.getBestPrices(poolId);
        require(!bidExists && !askExists, "empty market mutated the book");
    }

    function testCrossingLimitOrderLeavesRemainderOnBidBook() public {
        _place(sellerA, ISpotCLOB.Side.Sell, 100, 2, 1);
        bytes32 buy = _place(buyer, ISpotCLOB.Side.Buy, 100, 5, 2);

        _assertOrder(buy, 2, ISpotCLOB.OrderStatus.PartiallyFilled);
        (bool exists, uint128 price, uint128 quantity,,,) = exchange.getBestPrices(poolId);
        require(exists && price == 100 && quantity == 3, "remainder did not rest as best bid");
        _assertBalance(address(buyer), address(quote), 999_500, 300);
    }

    function testMarketSellConsumesHighestBidsFirst() public {
        bytes32 lowerBid = _place(buyer, ISpotCLOB.Side.Buy, 90, 3, 1);
        bytes32 higherBid = _place(buyer, ISpotCLOB.Side.Buy, 100, 2, 2);

        (, uint128 filled, uint256 quoteFilled) = sellerA.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, 4, 0, 4, 3
        );

        require(filled == 4 && quoteFilled == 380, "wrong market-sell result");
        _assertOrder(higherBid, 2, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(lowerBid, 2, ISpotCLOB.OrderStatus.PartiallyFilled);
        _assertBestBid(90);
        _assertBalance(address(sellerA), address(quote), 380, 0);
    }

    function testTopNReadIsSortedAggregatedAndExactLength() public {
        _place(buyer, ISpotCLOB.Side.Buy, 1, 2, 1);
        _place(buyer, ISpotCLOB.Side.Buy, 300, 3, 2);
        bytes32 firstAsk = _place(sellerA, ISpotCLOB.Side.Sell, 400, 4, 3);
        bytes32 secondAt400 = _place(sellerB, ISpotCLOB.Side.Sell, 400, 5, 4);
        _place(sellerA, ISpotCLOB.Side.Sell, 70_000, 6, 5);

        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            exchange.getOrderBook(poolId, 2);
        require(bids.length == 2 && asks.length == 2, "wrong depth length");
        require(bids[0].price == 300 && bids[0].quantity == 3, "wrong first bid");
        require(bids[1].price == 1 && bids[1].quantity == 2, "wrong second bid");
        require(asks[0].price == 400 && asks[0].quantity == 9, "wrong first ask");
        require(asks[1].price == 70_000 && asks[1].quantity == 6, "wrong second ask");

        (uint128 total, bytes32 head, bytes32 tail) =
            exchange.getPriceLevel(poolId, ISpotCLOB.Side.Sell, 400);
        require(total == 9 && head == firstAsk && tail == secondAt400, "wrong level metadata");
    }

    function testGetUserOrdersPaginatesNewestFirstAndFiltersFlags() public {
        bytes32 openOrder = _place(sellerA, ISpotCLOB.Side.Sell, 300, 1, 1);
        bytes32 cancelledOrder = _place(sellerA, ISpotCLOB.Side.Sell, 400, 2, 2);
        sellerA.cancel(exchange, cancelledOrder);
        bytes32 filledOrder = _place(sellerA, ISpotCLOB.Side.Sell, 100, 1, 3);
        _place(buyer, ISpotCLOB.Side.Buy, 100, 1, 4);

        require(exchange.USER_ORDER_FLAG_OPEN() == 1, "wrong open flag");
        require(exchange.USER_ORDER_FLAG_FILLED() == 2, "wrong filled flag");
        require(exchange.USER_ORDER_FLAG_CANCELED() == 4, "wrong canceled flag");

        (bytes32[] memory firstIds, bytes32 idsCursor) =
            exchange.getUserOrderIds(poolId, address(sellerA), bytes32(0), 2, 7);
        require(firstIds.length == 2, "wrong id page length");
        require(firstIds[0] == filledOrder && firstIds[1] == cancelledOrder, "wrong id page");
        require(idsCursor == openOrder, "wrong id cursor");

        (ISpotCLOB.UserOrderView[] memory firstPage, bytes32 nextCursor) =
            lens.getUserOrders(exchange, poolId, address(sellerA), bytes32(0), 2, 7);
        require(firstPage.length == 2, "wrong first page length");
        require(firstPage[0].orderId == filledOrder, "newest order missing");
        require(firstPage[1].orderId == cancelledOrder, "second order missing");
        require(nextCursor == openOrder, "wrong next cursor");

        (ISpotCLOB.UserOrderView[] memory secondPage, bytes32 finalCursor) =
            lens.getUserOrders(exchange, poolId, address(sellerA), nextCursor, 2, 7);
        require(secondPage.length == 1 && secondPage[0].orderId == openOrder, "wrong second page");
        require(finalCursor == bytes32(0), "pagination did not finish");

        (ISpotCLOB.UserOrderView[] memory openOrders,) =
            lens.getUserOrders(exchange, poolId, address(sellerA), bytes32(0), 10, 1);
        require(openOrders.length == 1 && openOrders[0].orderId == openOrder, "open filter failed");

        (ISpotCLOB.UserOrderView[] memory filledOrders,) =
            lens.getUserOrders(exchange, poolId, address(sellerA), bytes32(0), 10, 2);
        require(
            filledOrders.length == 1 && filledOrders[0].orderId == filledOrder,
            "filled filter failed"
        );

        (ISpotCLOB.UserOrderView[] memory cancelledOrders,) =
            lens.getUserOrders(exchange, poolId, address(sellerA), bytes32(0), 10, 4);
        require(
            cancelledOrders.length == 1 && cancelledOrders[0].orderId == cancelledOrder,
            "cancelled filter failed"
        );
    }

    function testGetUserOrdersClassifiesRestingAndClosedPartialOrders() public {
        bytes32 restingPartial = _place(sellerA, ISpotCLOB.Side.Sell, 200, 5, 1);
        _place(buyer, ISpotCLOB.Side.Buy, 200, 2, 2);

        bytes32 marketPartialAsk = _place(sellerA, ISpotCLOB.Side.Sell, 100, 2, 3);
        (bytes32 closedPartial,,) = buyer.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 3, 100, 0, 4
        );

        (bytes32[] memory openIds,) =
            exchange.getUserOrderIds(poolId, address(sellerA), bytes32(0), 10, 1);
        require(openIds.length == 1 && openIds[0] == restingPartial, "resting partial not open");

        (bytes32[] memory canceledIds,) =
            exchange.getUserOrderIds(poolId, address(buyer), bytes32(0), 10, 4);
        require(
            canceledIds.length == 1 && canceledIds[0] == closedPartial,
            "closed market partial not canceled"
        );
        _assertOrder(marketPartialAsk, 2, ISpotCLOB.OrderStatus.Filled);
    }

    function testGetUserOrdersRejectsInvalidFlagsAndPageSizes() public view {
        (bool zeroFlags,) = address(exchange)
            .staticcall(
                abi.encodeCall(
                    SpotCLOB.getUserOrderIds,
                    (poolId, address(sellerA), bytes32(0), uint16(1), uint8(0))
                )
            );
        require(!zeroFlags, "zero flags accepted");

        (bool unknownFlags,) = address(exchange)
            .staticcall(
                abi.encodeCall(
                    SpotCLOB.getUserOrderIds,
                    (poolId, address(sellerA), bytes32(0), uint16(1), uint8(8))
                )
            );
        require(!unknownFlags, "unknown flags accepted");

        (bool zeroLimit,) = address(exchange)
            .staticcall(
                abi.encodeCall(
                    SpotCLOB.getUserOrderIds,
                    (poolId, address(sellerA), bytes32(0), uint16(0), uint8(1))
                )
            );
        require(!zeroLimit, "zero limit accepted");

        (bool excessiveLimit,) = address(exchange)
            .staticcall(
                abi.encodeCall(
                    SpotCLOB.getUserOrderIds,
                    (poolId, address(sellerA), bytes32(0), uint16(257), uint8(1))
                )
            );
        require(!excessiveLimit, "excessive limit accepted");
    }

    function testCancelHeadMiddleTailAndRejectRepeatCancellation() public {
        bytes32 head = _place(sellerA, ISpotCLOB.Side.Sell, 500, 1, 1);
        bytes32 middle = _place(sellerA, ISpotCLOB.Side.Sell, 500, 2, 2);
        bytes32 tail = _place(sellerA, ISpotCLOB.Side.Sell, 500, 3, 3);

        sellerA.cancel(exchange, middle);
        (uint128 total, bytes32 activeHead, bytes32 activeTail) =
            exchange.getPriceLevel(poolId, ISpotCLOB.Side.Sell, 500);
        require(total == 4 && activeHead == head && activeTail == tail, "middle unlink failed");
        (, bytes32 headNext, bool headResting) = exchange.getOrderLinks(head);
        (bytes32 tailPrevious,, bool tailResting) = exchange.getOrderLinks(tail);
        require(
            headNext == tail && tailPrevious == head && headResting && tailResting,
            "neighbor links not repaired"
        );

        sellerA.cancel(exchange, head);
        (total, activeHead, activeTail) = exchange.getPriceLevel(poolId, ISpotCLOB.Side.Sell, 500);
        require(total == 3 && activeHead == tail && activeTail == tail, "head unlink failed");

        sellerA.cancel(exchange, tail);
        (total, activeHead, activeTail) = exchange.getPriceLevel(poolId, ISpotCLOB.Side.Sell, 500);
        require(
            total == 0 && activeHead == bytes32(0) && activeTail == bytes32(0), "tail unlink failed"
        );
        require(!sellerA.attemptCancel(exchange, tail), "repeat cancellation succeeded");
    }

    function testActivationAndConstructorValidation() public {
        SpotCLOB implementation = new SpotCLOB(IPoolRegistry(address(0)));
        (bool implementationInitialized,) = address(implementation)
            .call(abi.encodeCall(SpotCLOB.initialize, (IPoolRegistry(address(registry)))));
        require(!implementationInitialized, "implementation was not locked");

        SpotCLOB directBook = new SpotCLOB(registry);
        require(!sellerA.attemptActivate(directBook, poolId), "non-authority activated direct book");
        directBook.activatePool(poolId);
        (bool activatedTwice,) =
            address(directBook).call(abi.encodeCall(SpotCLOB.activatePool, (poolId)));
        require(!activatedTwice, "market activated twice");

        SpotCLOB emptyBook = new SpotCLOB(registry);
        (bool missingPool,) =
            address(emptyBook).call(abi.encodeCall(SpotCLOB.activatePool, (bytes32(uint256(123)))));
        require(!missingPool, "missing pool activated");
        require(directBook.marketId(address(base), address(quote)) == poolId, "wrong market id");
    }

    function testViewValidationAndPriceLevelActivity() public {
        bytes32 missingMarket = bytes32(uint256(123));
        (bool bestByAssets,) = address(exchange)
            .staticcall(
                abi.encodeWithSignature("getBestPrices(address,address)", address(1), address(2))
            );
        require(!bestByAssets, "missing asset market read succeeded");
        (bool bestById,) = address(exchange)
            .staticcall(abi.encodeWithSignature("getBestPrices(bytes32)", missingMarket));
        require(!bestById, "missing id market read succeeded");
        (bool missingBook,) = address(exchange)
            .staticcall(abi.encodeCall(SpotCLOB.getOrderBook, (missingMarket, uint16(1))));
        require(!missingBook, "missing order book read succeeded");
        (bool excessiveDepth,) = address(exchange)
            .staticcall(abi.encodeCall(SpotCLOB.getOrderBook, (poolId, uint16(257))));
        require(!excessiveDepth, "excessive book depth succeeded");

        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            exchange.getOrderBook(poolId, 0);
        require(bids.length == 0 && asks.length == 0, "zero depth returned levels");
        require(
            !exchange.isPriceLevelActive(poolId, ISpotCLOB.Side.Sell, 100), "empty level active"
        );
        bytes32 ask = _place(sellerA, ISpotCLOB.Side.Sell, 100, 1, 1);
        require(
            exchange.isPriceLevelActive(poolId, ISpotCLOB.Side.Sell, 100),
            "populated level inactive"
        );
        sellerA.cancel(exchange, ask);
        require(
            !exchange.isPriceLevelActive(poolId, ISpotCLOB.Side.Sell, 100), "cleared level active"
        );

        (bool invalidPriceMarket,) = address(exchange)
            .staticcall(
                abi.encodeCall(
                    SpotCLOB.getPriceLevel, (missingMarket, ISpotCLOB.Side.Buy, uint128(1))
                )
            );
        require(!invalidPriceMarket, "price level on missing market succeeded");
        require(!_callPriceLevel(0), "zero price succeeded");
        require(!_callPriceLevel(100_001), "out-of-range price succeeded");
    }

    function testOrderAndPaginationValidation() public {
        (ISpotCLOB.LimitOrder memory zeroOrder, ISpotCLOB.OrderState memory zeroState) =
            exchange.getOrder(bytes32(0));
        require(zeroOrder.trader == address(0) && zeroState.quantity == 0, "zero id populated");
        (ISpotCLOB.LimitOrder memory hugeOrder,) =
            exchange.getOrder(bytes32(uint256(type(uint64).max) + 1));
        require(hugeOrder.trader == address(0), "huge id populated");
        (ISpotCLOB.LimitOrder memory missingOrder,) = exchange.getOrder(bytes32(uint256(999)));
        require(missingOrder.trader == address(0), "missing id populated");
        require(!sellerA.attemptCancel(exchange, bytes32(0)), "zero id cancelled");
        require(
            !sellerA.attemptCancel(exchange, bytes32(uint256(type(uint64).max) + 1)),
            "huge id cancelled"
        );
        require(!sellerA.attemptCancel(exchange, bytes32(uint256(999))), "missing id cancelled");

        (bytes32 previous, bytes32 next, bool resting) = exchange.getOrderLinks(bytes32(0));
        require(previous == bytes32(0) && next == bytes32(0) && !resting, "zero links populated");
        (previous, next, resting) = exchange.getOrderLinks(bytes32(uint256(type(uint64).max) + 1));
        require(previous == bytes32(0) && next == bytes32(0) && !resting, "huge links populated");

        require(!_callUserIds(bytes32(uint256(123)), address(sellerA), bytes32(0)), "bad market");
        require(
            !_callUserIds(poolId, address(sellerA), bytes32(uint256(type(uint64).max) + 1)),
            "huge cursor"
        );
        bytes32 sellerOrder = _place(sellerA, ISpotCLOB.Side.Sell, 200, 1, 1);
        require(!_callUserIds(poolId, address(buyer), sellerOrder), "foreign cursor accepted");
    }

    function testLimitAndMarketRequestValidation() public {
        ISpotCLOB.LimitOrder memory order = ISpotCLOB.LimitOrder({
            trader: address(this),
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: ISpotCLOB.Side.Buy,
            price: 100,
            quantity: 0,
            expiry: 0,
            clientOrderId: 0
        });
        require(!_callLimit(order), "zero quantity accepted");
        order.quantity = 1;
        order.trader = address(buyer);
        require(!_callLimit(order), "unauthorized limit accepted");
        order.trader = address(this);
        order.baseAsset = address(1);
        require(!_callLimit(order), "invalid limit market accepted");
        order.baseAsset = address(base);
        order.price = 100_001;
        require(!_callLimit(order), "out-of-range limit accepted");
        order.price = 100;
        order.expiry = uint64(block.timestamp);
        require(!_callLimit(order), "expired limit accepted");

        ISpotCLOB.MarketOrder memory marketOrder = ISpotCLOB.MarketOrder({
            trader: address(this),
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: ISpotCLOB.Side.Buy,
            quantity: 0,
            priceLimit: 100,
            minFillQuantity: 0,
            clientOrderId: 0
        });
        require(!_callMarket(marketOrder), "zero market quantity accepted");
        marketOrder.quantity = 1;
        marketOrder.trader = address(buyer);
        require(!_callMarket(marketOrder), "unauthorized market accepted");
        marketOrder.trader = address(this);
        marketOrder.baseAsset = address(1);
        require(!_callMarket(marketOrder), "invalid market accepted");
        marketOrder.baseAsset = address(base);
        marketOrder.minFillQuantity = 2;
        require(!_callMarket(marketOrder), "excessive minimum fill accepted");
    }

    function testRejectsMisalignedPriceForLargerTickSize() public {
        SpotCLOBFactory otherFactory = new SpotCLOBFactory();
        MockERC20 otherBase = new MockERC20("OTHER_BASE");
        MockERC20 otherQuote = new MockERC20("OTHER_QUOTE");
        otherFactory.setQuoteToken(address(otherQuote), true);
        (, address otherBookAddress) =
            otherFactory.createPair(address(otherBase), address(otherQuote), 10, 1, 1_000);
        SpotCLOB otherBook = SpotCLOB(otherBookAddress);
        otherQuote.mint(address(buyer), 100);
        buyer.approve(otherQuote, otherBook);
        require(
            !buyer.attemptPlace(
                otherBook, address(otherBase), address(otherQuote), ISpotCLOB.Side.Buy, 11, 1
            ),
            "misaligned price accepted"
        );
    }

    function testExpiredMakerIsRemovedDuringMatching() public {
        uint64 expiry = uint64(block.timestamp + 1);
        bytes32 expiredAsk = sellerA.placeWithExpiry(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1, expiry
        );
        _place(sellerB, ISpotCLOB.Side.Sell, 110, 1, 2);
        vm.warp(block.timestamp + 2);
        (, uint128 filled, uint256 quoteFilled) = buyer.executeMarket(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 1, 110, 1, 3
        );
        require(filled == 1 && quoteFilled == 110, "live maker was not filled");
        _assertOrder(expiredAsk, 0, ISpotCLOB.OrderStatus.Cancelled);
        (,,, bool askExists,,) = exchange.getBestPrices(poolId);
        require(!askExists, "expired maker remained active");
    }

    function _callLimit(ISpotCLOB.LimitOrder memory order) private returns (bool success) {
        (success,) = address(exchange).call(abi.encodeCall(SpotCLOB.placeLimitOrder, (order)));
    }

    function _callMarket(ISpotCLOB.MarketOrder memory order) private returns (bool success) {
        (success,) = address(exchange)
            .call(abi.encodeCall(SpotCLOB.executeMarketOrder, (order, uint32(64))));
    }

    function _callPriceLevel(uint128 price) private view returns (bool success) {
        (success,) = address(exchange)
            .staticcall(abi.encodeCall(SpotCLOB.getPriceLevel, (poolId, ISpotCLOB.Side.Buy, price)));
    }

    function _callUserIds(bytes32 id, address trader, bytes32 cursor)
        private
        view
        returns (bool success)
    {
        (success,) = address(exchange)
            .staticcall(
                abi.encodeCall(SpotCLOB.getUserOrderIds, (id, trader, cursor, uint16(1), uint8(1)))
            );
    }

    function _place(
        TraderActor actor,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId
    ) private returns (bytes32) {
        return actor.place(
            exchange, address(base), address(quote), side, price, quantity, clientOrderId
        );
    }

    function _assertOrder(
        bytes32 orderId,
        uint128 expectedFilled,
        ISpotCLOB.OrderStatus expectedStatus
    ) private view {
        (, ISpotCLOB.OrderState memory state) = exchange.getOrder(orderId);
        require(state.filledQuantity == expectedFilled, "wrong filled quantity");
        require(state.status == expectedStatus, "wrong order status");
    }

    function _assertBalance(
        address account,
        address asset,
        uint256 expectedFree,
        uint256 expectedLocked
    ) private view {
        (uint256 free, uint256 locked,) = exchange.balanceOf(account, asset);
        require(free == expectedFree, "wrong free balance");
        require(locked == expectedLocked, "wrong locked balance");
    }

    function _assertBestAsk(uint128 expectedPrice) private view {
        (,,, bool exists, uint128 price,) = exchange.getBestPrices(poolId);
        require(exists && price == expectedPrice, "wrong best ask");
    }

    function _assertBestBid(uint128 expectedPrice) private view {
        (bool exists, uint128 price,,,,) = exchange.getBestPrices(poolId);
        require(exists && price == expectedPrice, "wrong best bid");
    }
}
