// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";

contract EVMOrderActionTrader {
    function approve(MockERC20 token, SpotCLOB exchange) external {
        token.approve(address(exchange), type(uint256).max);
    }

    function place(
        SpotCLOB exchange,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) external returns (bytes32 orderId) {
        return exchange.placeLimitOrderWithMaxBookSteps(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                price: price,
                quantity: quantity,
                expiry: 0,
                clientOrderId: clientOrderId
            }),
            maxBookSteps
        );
    }

    function market(
        SpotCLOB exchange,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) external returns (bytes32 orderId, uint128 filledQuantity, uint256 quoteQuantity) {
        return exchange.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                quantity: quantity,
                priceLimit: 0,
                minFillQuantity: quantity,
                clientOrderId: clientOrderId
            }),
            maxBookSteps
        );
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }
}

/// @notice Isolated transaction-style gas measurements for individual CLOB actions.
/// @dev The gas delta is measured around the actor-to-book call inside the Foundry harness. It
/// includes the harness call boundary and ABI wrapper, so it is useful for comparing scenarios but
/// is not an exact production transaction receipt.
contract EVMOrderActionBenchmarkTest {
    uint128 private constant ONE_BASE = 1 ether;
    uint128 private constant BASE_PRICE = 100 ether;
    uint128 private constant PRICE_STEP = 1 ether;
    uint256 private constant BASE_FUNDING = 10_000_000 ether;
    uint256 private constant QUOTE_FUNDING = 10_000_000_000 ether;

    SpotCLOBFactory private factory;
    SpotCLOB private exchange;
    MockERC20 private base;
    MockERC20 private quote;
    EVMOrderActionTrader private seller;
    EVMOrderActionTrader private buyer;
    bytes32 private poolId;

    event log_named_string(string key, string value);
    event log_named_uint(string key, uint256 value);

    function setUp() public {
        factory = new SpotCLOBFactory();
        base = new MockERC20("Benchmark Base", "BB", 18);
        quote = new MockERC20("Benchmark Quote", "BQ", 18);
        factory.setQuoteToken(address(quote), true);
        (, address book) = factory.createPair(address(base), address(quote));
        exchange = SpotCLOB(book);
        poolId = factory.pairId(address(base), address(quote));

        seller = new EVMOrderActionTrader();
        buyer = new EVMOrderActionTrader();
        base.mint(address(seller), BASE_FUNDING);
        quote.mint(address(buyer), QUOTE_FUNDING);
        seller.approve(base, exchange);
        buyer.approve(quote, exchange);
    }

    function testBenchmarkCreateLimitOrderAtNewPriceLevel() public {
        uint256 gasBefore = gasleft();
        bytes32 orderId = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, ONE_BASE, 1, 32);
        uint256 gasUsed = gasBefore - gasleft();

        _assertOrder(orderId, ONE_BASE, 0, ISpotCLOB.OrderStatus.Open);
        _assertBook(1, 1, 0, 0, BASE_PRICE, ONE_BASE);
        _record("create-limit-new-price-level", 0, 0, 0, gasUsed);
    }

    function testBenchmarkCreateLimitOrderAtExistingPriceLevel() public {
        bytes32 firstOrderId = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, ONE_BASE, 1, 32);

        uint256 gasBefore = gasleft();
        bytes32 secondOrderId = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, ONE_BASE, 2, 32);
        uint256 gasUsed = gasBefore - gasleft();

        _assertOrder(firstOrderId, ONE_BASE, 0, ISpotCLOB.OrderStatus.Open);
        _assertOrder(secondOrderId, ONE_BASE, 0, ISpotCLOB.OrderStatus.Open);
        _assertBook(2, 1, 0, 0, BASE_PRICE, 2 * ONE_BASE);
        _assertPriceLevel(ISpotCLOB.Side.Sell, BASE_PRICE, 2 * ONE_BASE);
        _record("create-limit-existing-price-level", 1, 1, 0, gasUsed);
    }

    function testBenchmarkCancelSingleOrder() public {
        bytes32 orderId = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, ONE_BASE, 1, 32);

        uint256 gasBefore = gasleft();
        seller.cancel(exchange, orderId);
        uint256 gasUsed = gasBefore - gasleft();

        _assertOrder(orderId, ONE_BASE, 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertBook(0, 0, 0, 0, 0, 0);
        _record("cancel-single-order", 1, 1, 0, gasUsed);
    }

    function testBenchmarkSingleFill() public {
        bytes32 makerOrderId = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, ONE_BASE, 1, 32);

        uint256 gasBefore = gasleft();
        bytes32 takerOrderId = _place(buyer, ISpotCLOB.Side.Buy, BASE_PRICE, ONE_BASE, 2, 32);
        uint256 gasUsed = gasBefore - gasleft();

        _assertOrder(makerOrderId, ONE_BASE, ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(takerOrderId, ONE_BASE, ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        _assertBook(0, 0, 0, 0, 0, 0);
        _record("single-limit-fill", 1, 1, 1, gasUsed);
    }

    function testBenchmarkMarketFillConsumes100OrdersAtOnePriceLevel() public {
        bytes32[] memory asks = _seedAsksAtOnePriceLevel(100);
        _assertBook(100, 1, 0, 0, BASE_PRICE, 100 * ONE_BASE);

        uint256 gasBefore = gasleft();
        (bytes32 takerOrderId, uint128 filledQuantity,) = _market(buyer, 100, 10_001, 128);
        uint256 gasUsed = gasBefore - gasleft();

        require(filledQuantity == 100 * ONE_BASE, "wrong market fill quantity");
        _assertOrder(takerOrderId, 100 * ONE_BASE, 100 * ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        _assertFilledPrefix(asks, 100);
        _assertBook(0, 0, 0, 0, 0, 0);
        _record("market-fill-100-single-price-level", 100, 1, 100, gasUsed);
    }

    function testBenchmarkMarketFillConsumes50RestingOrders() public {
        bytes32[] memory asks = _seedDenseAsks();
        _assertBook(2_000, 1_000, 0, 0, BASE_PRICE, 2 * ONE_BASE);

        uint256 gasBefore = gasleft();
        (bytes32 takerOrderId, uint128 filledQuantity,) = _market(buyer, 50, 51, 64);
        uint256 gasUsed = gasBefore - gasleft();

        require(filledQuantity == 50 * ONE_BASE, "wrong market fill quantity");
        _assertOrder(takerOrderId, 50 * ONE_BASE, 50 * ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        _assertFilledPrefix(asks, 50);
        _assertOrder(asks[50], ONE_BASE, 0, ISpotCLOB.OrderStatus.Open);
        _assertBook(1_950, 975, 0, 0, BASE_PRICE + 25 * PRICE_STEP, 2 * ONE_BASE);
        _record("market-fill-50-dense-1000-level-book", 2_000, 1_000, 50, gasUsed);
    }

    function testBenchmarkMarketFillConsumes100RestingOrders() public {
        bytes32[] memory asks = _seedDenseAsks();
        _assertBook(2_000, 1_000, 0, 0, BASE_PRICE, 2 * ONE_BASE);

        uint256 gasBefore = gasleft();
        (bytes32 takerOrderId, uint128 filledQuantity,) = _market(buyer, 100, 101, 128);
        uint256 gasUsed = gasBefore - gasleft();

        require(filledQuantity == 100 * ONE_BASE, "wrong market fill quantity");
        _assertOrder(takerOrderId, 100 * ONE_BASE, 100 * ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        _assertFilledPrefix(asks, 100);
        _assertOrder(asks[100], ONE_BASE, 0, ISpotCLOB.OrderStatus.Open);
        _assertBook(1_900, 950, 0, 0, BASE_PRICE + 50 * PRICE_STEP, 2 * ONE_BASE);
        _record("market-fill-100-dense-1000-level-book", 2_000, 1_000, 100, gasUsed);
    }

    function testBenchmarkMarketFillConsumes200RestingOrders() public {
        bytes32[] memory asks = _seedDenseAsks();
        _assertBook(2_000, 1_000, 0, 0, BASE_PRICE, 2 * ONE_BASE);

        uint256 gasBefore = gasleft();
        (bytes32 takerOrderId, uint128 filledQuantity,) = _market(buyer, 200, 201, 256);
        uint256 gasUsed = gasBefore - gasleft();

        require(filledQuantity == 200 * ONE_BASE, "wrong market fill quantity");
        _assertOrder(takerOrderId, 200 * ONE_BASE, 200 * ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        _assertFilledPrefix(asks, 200);
        _assertOrder(asks[200], ONE_BASE, 0, ISpotCLOB.OrderStatus.Open);
        _assertBook(1_800, 900, 0, 0, BASE_PRICE + 100 * PRICE_STEP, 2 * ONE_BASE);
        _assertPriceLevel(ISpotCLOB.Side.Sell, BASE_PRICE + 100 * PRICE_STEP, 2 * ONE_BASE);
        _record("market-fill-200-dense-1000-level-book", 2_000, 1_000, 200, gasUsed);
    }

    /// @dev Dense fixture: 2,000 one-base asks, exactly two at each of 1,000 consecutive levels.
    /// The 50/100/200 market scenarios seed this fixture before their gas windows.
    function _seedDenseAsks() private returns (bytes32[] memory orderIds) {
        orderIds = new bytes32[](2_000);
        for (uint256 level; level < 1_000; ++level) {
            uint128 price = BASE_PRICE + uint128(level) * PRICE_STEP;
            orderIds[2 * level] =
                _place(seller, ISpotCLOB.Side.Sell, price, ONE_BASE, uint64(1 + 2 * level), 256);
            orderIds[2 * level + 1] =
                _place(seller, ISpotCLOB.Side.Sell, price, ONE_BASE, uint64(2 + 2 * level), 256);
        }
    }

    function _seedAsksAtOnePriceLevel(uint256 orderCount)
        private
        returns (bytes32[] memory orderIds)
    {
        orderIds = new bytes32[](orderCount);
        for (uint256 i; i < orderCount; ++i) {
            orderIds[i] = _place(
                seller,
                ISpotCLOB.Side.Sell,
                BASE_PRICE,
                ONE_BASE,
                uint64(i + 1),
                uint32(orderCount + 1)
            );
        }
    }

    function _place(
        EVMOrderActionTrader trader,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) private returns (bytes32 orderId) {
        return trader.place(
            exchange,
            address(base),
            address(quote),
            side,
            price,
            quantity,
            clientOrderId,
            maxBookSteps
        );
    }

    function _market(
        EVMOrderActionTrader trader,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) private returns (bytes32 orderId, uint128 filledQuantity, uint256 quoteQuantity) {
        return trader.market(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Buy,
            quantity * ONE_BASE,
            clientOrderId,
            maxBookSteps
        );
    }

    function _assertFilledPrefix(bytes32[] memory orderIds, uint256 filledCount) private view {
        for (uint256 i; i < filledCount; ++i) {
            _assertOrder(orderIds[i], ONE_BASE, ONE_BASE, ISpotCLOB.OrderStatus.Filled);
        }
    }

    function _assertOrder(
        bytes32 orderId,
        uint128 expectedQuantity,
        uint128 expectedFilled,
        ISpotCLOB.OrderStatus expectedStatus
    ) private view {
        (, ISpotCLOB.OrderState memory state) = exchange.getOrder(orderId);
        require(state.quantity == expectedQuantity, "wrong order quantity");
        require(state.filledQuantity == expectedFilled, "wrong filled quantity");
        require(state.status == expectedStatus, "wrong order status");
    }

    function _assertBook(
        uint256 expectedOrders,
        uint256 expectedLevels,
        uint128 expectedBidPrice,
        uint128 expectedBidQuantity,
        uint128 expectedAskPrice,
        uint128 expectedAskQuantity
    ) private view {
        uint256 activeLevels;
        uint256 activeOrders;
        for (uint256 i; i < 1_000; ++i) {
            uint128 price = BASE_PRICE + uint128(i) * PRICE_STEP;
            if (exchange.isPriceLevelActive(poolId, ISpotCLOB.Side.Sell, price)) {
                ++activeLevels;
                (uint128 quantity,,) = exchange.getPriceLevel(poolId, ISpotCLOB.Side.Sell, price);
                activeOrders += quantity / ONE_BASE;
            }
        }
        require(activeOrders == expectedOrders, "wrong active order count");
        require(activeLevels == expectedLevels, "wrong active price level count");

        (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        ) = exchange.getBestPrices(poolId);
        require(bidExists == (expectedBidPrice != 0), "unexpected bid existence");
        require(askExists == (expectedAskPrice != 0), "unexpected ask existence");
        if (bidExists) {
            require(bidPrice == expectedBidPrice, "wrong best bid price");
            require(bidQuantity == expectedBidQuantity, "wrong best bid quantity");
        }
        if (askExists) {
            require(askPrice == expectedAskPrice, "wrong best ask price");
            require(askQuantity == expectedAskQuantity, "wrong best ask quantity");
        }
    }

    function _assertPriceLevel(ISpotCLOB.Side side, uint128 price, uint128 expectedQuantity)
        private
        view
    {
        (uint128 quantity, bytes32 headOrderId, bytes32 tailOrderId) =
            exchange.getPriceLevel(poolId, side, price);
        require(quantity == expectedQuantity, "wrong price level quantity");
        require(headOrderId != bytes32(0), "missing price level head");
        require(tailOrderId != bytes32(0), "missing price level tail");
    }

    function _record(
        string memory benchmark,
        uint256 bookOrders,
        uint256 priceLevels,
        uint256 matches,
        uint256 gasUsed
    ) private {
        emit log_named_string("benchmark", benchmark);
        emit log_named_uint("book orders", bookOrders);
        emit log_named_uint("price levels", priceLevels);
        emit log_named_uint("matches", matches);
        emit log_named_uint("gas used", gasUsed);
        emit log_named_uint("gas per match", matches == 0 ? 0 : gasUsed / matches);
    }
}
