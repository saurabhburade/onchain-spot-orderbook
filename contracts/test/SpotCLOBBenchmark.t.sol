// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

interface Vm {
    function envOr(string calldata key, bool defaultValue) external returns (bool value);
    function skip(bool skipTest) external;
}

contract BenchmarkToken {
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

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

contract BenchmarkTrader {
    function approve(BenchmarkToken token, SpotCLOB exchange) external {
        token.approve(address(exchange), type(uint256).max);
    }

    function place(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) external returns (bytes32) {
        return exchange.placeLimitOrderWithMaxBookSteps(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                price: price,
                quantity: quantity,
                expiry: 0,
                clientOrderId: clientOrderId
            }),
            maxBookSteps
        );
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }

    function market(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) external returns (bytes32 orderId) {
        (orderId,,) = exchange.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: address(this),
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                quantity: quantity,
                priceLimit: 0,
                minFillQuantity: quantity,
                clientOrderId: clientOrderId
            }),
            maxBookSteps
        );
    }
}

contract SpotCLOBBenchmarkTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 private constant LOT_SIZE = 1 ether;
    uint128 private constant BASE_PRICE = 100;
    uint256 private constant BASE_FUNDING = 100_000_000 ether;
    uint256 private constant QUOTE_FUNDING = 100_000_000_000;

    SpotCLOB private exchange;
    SpotCLOBFactory private registry;
    BenchmarkToken private base;
    BenchmarkToken private quote;
    BenchmarkTrader private seller;
    BenchmarkTrader private buyer;

    event BenchmarkGas(bytes32 indexed phase, uint256 gasUsed, uint256 operations);
    event BenchmarkChecksum(bytes32 indexed phase, uint256 checksum);
    event log_named_bytes32(string key, bytes32 value);
    event log_named_uint(string key, uint256 value);

    function setUp() public {
        BenchmarkToken firstToken = new BenchmarkToken();
        BenchmarkToken secondToken = new BenchmarkToken();
        if (address(firstToken) < address(secondToken)) {
            base = firstToken;
            quote = secondToken;
        } else {
            base = secondToken;
            quote = firstToken;
        }
        seller = new BenchmarkTrader();
        buyer = new BenchmarkTrader();

        registry = new SpotCLOBFactory();
        registry.setQuoteToken(address(quote), true);
        registry.setPairLotDecimals(address(base), address(quote), 0);
        (, address book) = registry.createPair(address(base), address(quote), 1, 1, 1_000_000);
        exchange = SpotCLOB(book);

        base.mint(address(seller), BASE_FUNDING);
        quote.mint(address(buyer), QUOTE_FUNDING);
        seller.approve(base, exchange);
        buyer.approve(quote, exchange);
    }

    /// @dev Default benchmark: 100 orders distributed over five price levels.
    function testBenchmark100OrdersFewLevels() public {
        uint256 orderCount = 100;
        bytes32[] memory asks = new bytes32[](orderCount);

        uint256 gasBefore = gasleft();
        for (uint256 i; i < orderCount; ++i) {
            asks[i] = _place(
                seller, ISpotCLOB.Side.Sell, BASE_PRICE + uint128(i % 5), 1, uint64(i + 1), 64
            );
        }
        _recordGas("place", gasBefore - gasleft(), orderCount);

        gasBefore = gasleft();
        for (uint256 i; i < orderCount / 10; ++i) {
            seller.cancel(exchange, asks[i * 10]);
        }
        _recordGas("cancel", gasBefore - gasleft(), orderCount / 10);

        gasBefore = gasleft();
        bytes32 taker = _place(buyer, ISpotCLOB.Side.Buy, 105, 20, 10_001, 64);
        _recordGas("match", gasBefore - gasleft(), 20);

        _assertOrder(taker, 20, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(asks[0], 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertOrder(asks[2], 0, ISpotCLOB.OrderStatus.Open);
        _assertBestPrices(0, 101, 0, 10);
        _assertNoCrossedBook();
        _readOrders(asks);
    }

    /// @dev Default benchmark: 100 orders at 100 distinct price levels.
    function testBenchmark100OrdersManyLevels() public {
        uint256 orderCount = 100;
        bytes32[] memory asks = new bytes32[](orderCount);

        uint256 gasBefore = gasleft();
        for (uint256 i; i < orderCount; ++i) {
            asks[i] = _place(
                seller, ISpotCLOB.Side.Sell, BASE_PRICE + uint128(i), 1, uint64(i + 1), 128
            );
        }
        _recordGas("place", gasBefore - gasleft(), orderCount);

        gasBefore = gasleft();
        for (uint256 i; i < orderCount / 10; ++i) {
            seller.cancel(exchange, asks[i]);
        }
        _recordGas("cancel", gasBefore - gasleft(), orderCount / 10);

        gasBefore = gasleft();
        bytes32 taker = _place(buyer, ISpotCLOB.Side.Buy, 200, 20, 10_001, 128);
        _recordGas("match", gasBefore - gasleft(), 20);

        _assertOrder(taker, 20, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(asks[0], 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertOrder(asks[30], 0, ISpotCLOB.OrderStatus.Open);
        _assertBestPrices(0, 130, 1, 1);
        _assertNoCrossedBook();
        _readOrders(asks);
    }

    /// @dev Run with RUN_LARGE_BENCHMARKS=true and match this test explicitly.
    function testBenchmark1000OrdersFewLevels() public {
        _skipUnlessLargeEnabled();
        _runScaledBenchmark(1_000, false);
    }

    /// @dev Run with RUN_LARGE_BENCHMARKS=true and match this test explicitly.
    function testBenchmark10000OrdersManyLevels() public {
        _skipUnlessLargeEnabled();
        _runScaledBenchmark(10_000, true);
    }

    /// @dev Deterministic 65% limits, 15% cancellations, 10% market buys, and 10% market sells.
    function testBenchmarkMixedDistribution100Orders() public {
        bytes32[] memory limitOrders = new bytes32[](65);
        bytes32[] memory marketBuys = new bytes32[](10);
        bytes32[] memory marketSells = new bytes32[](10);

        uint256 gasBefore = gasleft();
        for (uint256 i; i < 33; ++i) {
            limitOrders[i] = _place(
                seller, ISpotCLOB.Side.Sell, BASE_PRICE + uint128(i), 1, uint64(i + 1), 128
            );
        }
        for (uint256 i; i < 32; ++i) {
            limitOrders[33 + i] =
                _place(buyer, ISpotCLOB.Side.Buy, 99 - uint128(i), 1, uint64(34 + i), 128);
        }
        _recordGas("limit-place", gasBefore - gasleft(), 65);

        gasBefore = gasleft();
        for (uint256 i; i < 8; ++i) {
            seller.cancel(exchange, limitOrders[i]);
        }
        for (uint256 i; i < 7; ++i) {
            buyer.cancel(exchange, limitOrders[33 + i]);
        }
        _recordGas("cancel", gasBefore - gasleft(), 15);

        gasBefore = gasleft();
        for (uint256 i; i < 10; ++i) {
            marketBuys[i] = _market(buyer, ISpotCLOB.Side.Buy, 1, uint64(101 + i), 128);
        }
        _recordGas("market-buy", gasBefore - gasleft(), 10);

        gasBefore = gasleft();
        for (uint256 i; i < 10; ++i) {
            marketSells[i] = _market(seller, ISpotCLOB.Side.Sell, 1, uint64(201 + i), 128);
        }
        _recordGas("market-sell", gasBefore - gasleft(), 10);

        _assertBestPrices(82, 118, 1, 1);
        _assertNoCrossedBook();
        _assertOrder(limitOrders[0], 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertOrder(limitOrders[18], 0, ISpotCLOB.OrderStatus.Open);
        _assertOrder(marketBuys[9], 1, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(marketSells[9], 1, ISpotCLOB.OrderStatus.Filled);
        _readOrders(limitOrders);
        _readOrders(marketBuys);
        _readOrders(marketSells);
    }

    /// @dev Measures one market buy that consumes 50 individual asks across 50 price levels.
    function testBenchmarkMarketBuyConsumes50Asks() public {
        for (uint256 i; i < 50; ++i) {
            _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE + uint128(i), 1, uint64(i + 1), 64);
        }

        uint256 gasBefore = gasleft();
        bytes32 taker = _market(buyer, ISpotCLOB.Side.Buy, 50, 1_001, 64);
        _recordGas("market-buy-50", gasBefore - gasleft(), 50);

        _assertOrder(taker, 50, ISpotCLOB.OrderStatus.Filled);
        _assertBestPrices(0, 0, 0, 0);
    }

    /// @dev Measures one market sell that consumes 50 individual bids across 50 price levels.
    function testBenchmarkMarketSellConsumes50Bids() public {
        for (uint256 i; i < 50; ++i) {
            _place(buyer, ISpotCLOB.Side.Buy, BASE_PRICE + uint128(i), 1, uint64(i + 1), 64);
        }

        uint256 gasBefore = gasleft();
        bytes32 taker = _market(seller, ISpotCLOB.Side.Sell, 50, 1_001, 64);
        _recordGas("market-sell-50", gasBefore - gasleft(), 50);

        _assertOrder(taker, 50, ISpotCLOB.OrderStatus.Filled);
        _assertBestPrices(0, 0, 0, 0);
    }

    /// @dev Measures a crossing buy limit that completely fills one resting ask.
    function testBenchmarkCrossingBuyLimitFillsOneAsk() public {
        bytes32 maker = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, 1, 1, 64);

        uint256 gasBefore = gasleft();
        bytes32 taker = _place(buyer, ISpotCLOB.Side.Buy, BASE_PRICE, 1, 2, 64);
        _recordGas("limit-buy-fill-1", gasBefore - gasleft(), 1);

        _assertOrder(maker, 1, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(taker, 1, ISpotCLOB.OrderStatus.Filled);
        _assertBestPrices(0, 0, 0, 0);
    }

    /// @dev Measures a crossing sell limit that completely fills one resting bid.
    function testBenchmarkCrossingSellLimitFillsOneBid() public {
        bytes32 maker = _place(buyer, ISpotCLOB.Side.Buy, BASE_PRICE, 1, 1, 64);

        uint256 gasBefore = gasleft();
        bytes32 taker = _place(seller, ISpotCLOB.Side.Sell, BASE_PRICE, 1, 2, 64);
        _recordGas("limit-sell-fill-1", gasBefore - gasleft(), 1);

        _assertOrder(maker, 1, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(taker, 1, ISpotCLOB.OrderStatus.Filled);
        _assertBestPrices(0, 0, 0, 0);
    }

    function _runScaledBenchmark(uint256 orderCount, bool manyLevels) private {
        bytes32[] memory asks = new bytes32[](orderCount);
        uint256 cancellations = orderCount / 10;
        uint256 matchQuantity = cancellations;
        uint128 buyPrice = BASE_PRICE + uint128(orderCount);
        uint32 maxBookSteps = uint32(orderCount + 1);

        uint256 gasBefore = gasleft();
        for (uint256 i; i < orderCount; ++i) {
            uint128 price = manyLevels ? BASE_PRICE + uint128(i) : BASE_PRICE + uint128(i % 5);
            asks[i] = _place(seller, ISpotCLOB.Side.Sell, price, 1, uint64(i + 1), maxBookSteps);
        }
        _recordGas("place", gasBefore - gasleft(), orderCount);

        gasBefore = gasleft();
        for (uint256 i; i < cancellations; ++i) {
            uint256 index = manyLevels ? i : i * 10;
            seller.cancel(exchange, asks[index]);
        }
        _recordGas("cancel", gasBefore - gasleft(), cancellations);

        gasBefore = gasleft();
        bytes32 taker = _place(
            buyer,
            ISpotCLOB.Side.Buy,
            buyPrice,
            uint128(matchQuantity),
            uint64(orderCount + 1),
            maxBookSteps
        );
        _recordGas("match", gasBefore - gasleft(), matchQuantity);

        _assertOrder(taker, uint128(matchQuantity), ISpotCLOB.OrderStatus.Filled);
        _assertOrder(asks[0], 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertNoCrossedBook();
        _readOrders(asks);
    }

    function _place(
        BenchmarkTrader trader,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) private returns (bytes32) {
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
        BenchmarkTrader trader,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint64 clientOrderId,
        uint32 maxBookSteps
    ) private returns (bytes32) {
        return trader.market(
            exchange, address(base), address(quote), side, quantity, clientOrderId, maxBookSteps
        );
    }

    function _readOrders(bytes32[] memory orderIds) private {
        uint256 gasBefore = gasleft();
        uint256 checksum;
        for (uint256 i; i < orderIds.length; ++i) {
            (, ISpotCLOB.OrderState memory state) = exchange.getOrder(orderIds[i]);
            checksum += uint256(state.filledQuantity) + uint256(state.status);
        }
        (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        ) = exchange.getBestPrices(registry.pairId(address(base), address(quote)));
        checksum += bidExists ? uint256(bidPrice) + bidQuantity : 0;
        checksum += askExists ? uint256(askPrice) + askQuantity : 0;
        _recordGas("read", gasBefore - gasleft(), orderIds.length + 1);
        emit BenchmarkChecksum("read", checksum);

        _benchmarkDepthRead(10);
        _benchmarkDepthRead(50);
        _benchmarkDepthRead(100);
    }

    function _benchmarkDepthRead(uint16 depth) private {
        uint256 gasBefore = gasleft();
        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            exchange.getOrderBook(registry.pairId(address(base), address(quote)), depth);
        uint256 gasUsed = gasBefore - gasleft();
        _recordGas("top-depth", gasUsed, depth);
        emit BenchmarkChecksum("top-depth", bids.length + asks.length);
    }

    function _recordGas(bytes32 phase, uint256 gasUsed, uint256 operations) private {
        emit BenchmarkGas(phase, gasUsed, operations);
        emit log_named_bytes32("phase", phase);
        emit log_named_uint("gas used", gasUsed);
        emit log_named_uint("operations/depth", operations);
        emit log_named_uint("gas per operation", operations == 0 ? 0 : gasUsed / operations);
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

    function _assertBestPrices(
        uint128 expectedBidPrice,
        uint128 expectedAskPrice,
        uint128 expectedBidQuantity,
        uint128 expectedAskQuantity
    ) private view {
        (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        ) = exchange.getBestPrices(registry.pairId(address(base), address(quote)));
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

    function _assertNoCrossedBook() private view {
        (bool bidExists, uint128 bidPrice,, bool askExists, uint128 askPrice,) =
            exchange.getBestPrices(registry.pairId(address(base), address(quote)));
        if (bidExists && askExists) require(bidPrice < askPrice, "crossed resting book");
    }

    function _skipUnlessLargeEnabled() private {
        if (!vm.envOr("RUN_LARGE_BENCHMARKS", false)) vm.skip(true);
    }
}
