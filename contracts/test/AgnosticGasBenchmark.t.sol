// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

interface LargeBenchmarkVm {
    function envOr(string calldata key, bool defaultValue) external returns (bool value);
    function skip(bool skipTest) external;
}

contract AgnosticBenchmarkToken {
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

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract BlocklistAgnosticBenchmarkToken is AgnosticBenchmarkToken {
    mapping(address account => bool blocked) public blacklisted;

    constructor() AgnosticBenchmarkToken(6) { }

    function setBlacklisted(address account, bool blocked) external {
        blacklisted[account] = blocked;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blacklisted[to]) revert("blacklisted receiver");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (blacklisted[to]) revert("blacklisted receiver");
        return super.transferFrom(from, to, amount);
    }
}

contract AgnosticBenchmarkTrader {
    function approve(AgnosticBenchmarkToken token, SpotCLOB exchange) external {
        token.approve(address(exchange), type(uint256).max);
    }

    function place(
        SpotCLOB exchange,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId
    ) external returns (bytes32) {
        return exchange.placeLimitOrderWithMaxBookSteps(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                price: price,
                quantity: quantity,
                clientOrderId: clientOrderId
            }),
            64
        );
    }

    function market(
        SpotCLOB exchange,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 quantity,
        uint64 clientOrderId
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
                minReceive: 0,
                clientOrderId: clientOrderId
            }),
            64
        );
    }

    function marketWithMaxBookSteps(
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
                minReceive: 0,
                clientOrderId: clientOrderId
            }),
            maxBookSteps
        );
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }
}

/// @notice Transaction-style gas benchmarks for the full uint128 price tree.
/// @dev Run with: forge test --match-path test/AgnosticGasBenchmark.t.sol --gas-report -vv
contract AgnosticGasBenchmarkTest {
    LargeBenchmarkVm private constant vm =
        LargeBenchmarkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 private constant ORDER_QUANTITY = 10 ether;
    uint128 private constant BASE_PRICE = 1 ether; // 1 USDC/token in priceX18.
    uint128 private constant PRICE_STEP = 1e15; // 0.001 USDC.
    uint128 private constant LARGE_BENCHMARK_PRICE_STEP = 1e12; // 0.000001 USDC.
    uint256 private constant TEN_USDC = 10_000_000;
    uint256 private constant QUOTE_DENOMINATOR = 1e30;
    uint256 private constant LARGE_ORDER_COUNT = 100_000;
    uint256 private constant LARGE_MAKER_COUNT = 10;

    struct QuarantineBenchmarkScenario {
        AgnosticBenchmarkToken base;
        BlocklistAgnosticBenchmarkToken quote;
        SpotCLOB exchange;
        AgnosticBenchmarkTrader buyer;
        AgnosticBenchmarkTrader[] makers;
        uint128 totalBaseQuantity;
    }

    SpotCLOBFactory private factory;
    SpotCLOB private exchange;
    AgnosticBenchmarkToken private base;
    AgnosticBenchmarkToken private quote;
    AgnosticBenchmarkTrader private seller;
    AgnosticBenchmarkTrader private buyer;
    bytes32 private poolId;
    SpotCLOBLens private lens;

    event BenchmarkGas(bytes32 indexed operation, uint256 gasUsed, uint256 quoteCount);
    event log_named_bytes32(string key, bytes32 value);
    event log_named_uint(string key, uint256 value);

    function setUp() public {
        factory = new SpotCLOBFactory();
        base = new AgnosticBenchmarkToken(18);
        quote = new AgnosticBenchmarkToken(6);
        factory.setQuoteToken(address(quote), true);
        (, address book) = factory.createPair(address(base), address(quote));
        poolId = factory.pairId(address(base), address(quote));
        exchange = SpotCLOB(book);
        lens = new SpotCLOBLens();
        seller = new AgnosticBenchmarkTrader();
        buyer = new AgnosticBenchmarkTrader();
        base.mint(address(seller), 1_000_000 ether);
        quote.mint(address(buyer), 1_000_000_000 * 1e6);
        seller.approve(base, exchange);
        buyer.approve(quote, exchange);
    }

    function testGasCreateAgnosticMarket() public {
        SpotCLOBFactory otherFactory = new SpotCLOBFactory();
        AgnosticBenchmarkToken otherBase = new AgnosticBenchmarkToken(18);
        otherFactory.setQuoteToken(address(quote), true);

        uint256 beforeGas = gasleft();
        otherFactory.createPair(address(otherBase), address(quote));
        _record("create-market", beforeGas - gasleft(), 1);
    }

    function testGasPlaceFirstPriceLevel() public {
        uint256 beforeGas = gasleft();
        seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            BASE_PRICE,
            ORDER_QUANTITY,
            1
        );
        _record("place-first-level", beforeGas - gasleft(), 1);
    }

    function testGasPlaceSamePriceAndCancel() public {
        seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            BASE_PRICE,
            ORDER_QUANTITY,
            1
        );
        uint256 beforeGas = gasleft();
        bytes32 second = seller.place(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Sell,
            BASE_PRICE,
            ORDER_QUANTITY,
            2
        );
        _record("place-same-level", beforeGas - gasleft(), 1);

        beforeGas = gasleft();
        seller.cancel(exchange, second);
        _record("cancel-order", beforeGas - gasleft(), 1);
    }

    function testGasReadFunctionsAtFiftyLevels() public {
        _seedAsks(50);

        uint256 beforeGas = gasleft();
        exchange.getBestPrices(poolId);
        _record("get-best-prices", beforeGas - gasleft(), 1);

        beforeGas = gasleft();
        exchange.getOrderBook(poolId, 50);
        _record("get-book-50", beforeGas - gasleft(), 50);

        beforeGas = gasleft();
        lens.minimumOrderQuantity(exchange, address(base), address(quote), BASE_PRICE);
        _record("minimum-quantity", beforeGas - gasleft(), 1);

        beforeGas = gasleft();
        lens.quoteAmount(exchange, address(base), address(quote), BASE_PRICE, ORDER_QUANTITY);
        _record("quote-amount", beforeGas - gasleft(), 1);
    }

    function testGasMarketBuyConsumesOneQuote() public {
        _seedAsks(1);
        uint256 beforeGas = gasleft();
        (, uint128 filled,) = buyer.market(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, ORDER_QUANTITY, 101
        );
        _record("market-buy-1", beforeGas - gasleft(), 1);
        require(filled == ORDER_QUANTITY, "wrong fill");
    }

    function testGasMarketBuyConsumesFiftyQuotes() public {
        _seedAsks(50);
        uint256 beforeGas = gasleft();
        (, uint128 filled,) = buyer.market(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 50 * ORDER_QUANTITY, 101
        );
        _record("market-buy-50", beforeGas - gasleft(), 50);
        require(filled == 50 * ORDER_QUANTITY, "wrong fill");
    }

    function testGasMarketSellConsumesFiftyQuotes() public {
        _seedBids(50);
        uint256 beforeGas = gasleft();
        (, uint128 filled,) = seller.market(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, 50 * ORDER_QUANTITY, 201
        );
        _record("market-sell-50", beforeGas - gasleft(), 50);
        require(filled == 50 * ORDER_QUANTITY, "wrong fill");
    }

    /// @dev Opt-in because seeding 100,000 independent orders is intentionally expensive.
    /// Run with RUN_100K_ORDER_BENCHMARK=true and match this test explicitly.
    function testBenchmarkMarketBuyConsumes100000TenUsdcOrdersAcrossPriceLevels() public {
        if (!vm.envOr("RUN_100K_ORDER_BENCHMARK", false)) vm.skip(true);

        AgnosticBenchmarkTrader[] memory makers = new AgnosticBenchmarkTrader[](LARGE_MAKER_COUNT);
        for (uint256 i; i < makers.length; ++i) {
            makers[i] = new AgnosticBenchmarkTrader();
            base.mint(address(makers[i]), 200_000 ether);
            makers[i].approve(base, exchange);
        }

        uint128 totalBaseQuantity;
        for (uint256 i; i < LARGE_ORDER_COUNT; ++i) {
            uint128 price = BASE_PRICE + uint128(i) * LARGE_BENCHMARK_PRICE_STEP;
            uint128 quantity = _minimumTenUsdcQuantity(price);
            require(
                uint256(price) * quantity / QUOTE_DENOMINATOR == TEN_USDC,
                "order is not exactly 10 USDC"
            );
            totalBaseQuantity += quantity;
            AgnosticBenchmarkTrader maker = makers[i % makers.length];
            maker.place(
                exchange,
                address(base),
                address(quote),
                ISpotCLOB.Side.Sell,
                price,
                quantity,
                uint64(i + 1)
            );
        }

        uint256 beforeGas = gasleft();
        (, uint128 filled, uint256 grossQuote) = buyer.marketWithMaxBookSteps(
            exchange,
            address(base),
            address(quote),
            ISpotCLOB.Side.Buy,
            totalBaseQuantity,
            100_001,
            uint32(LARGE_ORDER_COUNT)
        );
        uint256 gasUsed = beforeGas - gasleft();

        _record("market-buy-100000", gasUsed, LARGE_ORDER_COUNT);
        emit log_named_uint("gross quote atoms", grossQuote);
        emit log_named_uint("gross quote USDC", grossQuote / 1e6);
        require(filled == totalBaseQuantity, "wrong fill");
        require(grossQuote == LARGE_ORDER_COUNT * TEN_USDC, "wrong gross quote");
        (,,, bool askExists,,) = exchange.getBestPrices(poolId);
        require(!askExists, "asks remain after full market fill");
    }

    /// @dev Same 1,000,000-USDC book as the fill benchmark, but every maker is blocked from
    /// receiving quote settlement so all 100,000 orders take the quarantine path.
    function testBenchmarkMarketBuyQuarantines100000TenUsdcOrdersAcrossPriceLevels() public {
        if (!vm.envOr("RUN_100K_ORDER_BENCHMARK", false)) vm.skip(true);
        QuarantineBenchmarkScenario memory scenario = _quarantineBenchmarkScenario();

        uint256 beforeGas = gasleft();
        (, uint128 filled, uint256 grossQuote) = scenario.buyer
            .marketWithMaxBookSteps(
                scenario.exchange,
                address(scenario.base),
                address(scenario.quote),
                ISpotCLOB.Side.Buy,
                scenario.totalBaseQuantity,
                100_001,
                uint32(LARGE_ORDER_COUNT)
            );
        uint256 gasUsed = beforeGas - gasleft();

        emit BenchmarkGas("quarantine-100000", gasUsed, LARGE_ORDER_COUNT);
        emit log_named_uint("gas used", gasUsed);
        emit log_named_uint("orders quarantined", LARGE_ORDER_COUNT);
        emit log_named_uint("gas per quarantine", gasUsed / LARGE_ORDER_COUNT);
        emit log_named_uint("book gross USDC", LARGE_ORDER_COUNT * TEN_USDC / 1e6);
        require(filled == 0 && grossQuote == 0, "cleanup-only market order filled");
        (,,, bool askExists,,) = scenario.exchange
            .getBestPrices(
                scenario.exchange.marketId(address(scenario.base), address(scenario.quote))
            );
        require(!askExists, "quarantined asks remain active");
    }

    function _seedAsks(uint256 count) private {
        for (uint256 i; i < count; ++i) {
            seller.place(
                exchange,
                address(base),
                address(quote),
                ISpotCLOB.Side.Sell,
                BASE_PRICE + uint128(i) * PRICE_STEP,
                ORDER_QUANTITY,
                uint64(i + 1)
            );
        }
    }

    function _seedBids(uint256 count) private {
        for (uint256 i; i < count; ++i) {
            buyer.place(
                exchange,
                address(base),
                address(quote),
                ISpotCLOB.Side.Buy,
                BASE_PRICE + uint128(i) * PRICE_STEP,
                ORDER_QUANTITY,
                uint64(i + 1)
            );
        }
    }

    function _minimumTenUsdcQuantity(uint128 price) private pure returns (uint128) {
        uint256 numerator = TEN_USDC * QUOTE_DENOMINATOR;
        uint256 quantity = numerator / price;
        if (numerator % price != 0) ++quantity;
        return uint128(quantity);
    }

    function _quarantineBenchmarkScenario()
        private
        returns (QuarantineBenchmarkScenario memory scenario)
    {
        SpotCLOBFactory largeFactory = new SpotCLOBFactory();
        scenario.base = new AgnosticBenchmarkToken(18);
        scenario.quote = new BlocklistAgnosticBenchmarkToken();
        largeFactory.setQuoteToken(address(scenario.quote), true);
        (, address book) = largeFactory.createPair(address(scenario.base), address(scenario.quote));
        scenario.exchange = SpotCLOB(book);
        scenario.buyer = new AgnosticBenchmarkTrader();
        scenario.quote.mint(address(scenario.buyer), 1_000_000_000 * 1e6);
        scenario.buyer.approve(scenario.quote, scenario.exchange);

        scenario.makers = new AgnosticBenchmarkTrader[](LARGE_MAKER_COUNT);
        for (uint256 i; i < scenario.makers.length; ++i) {
            scenario.makers[i] = new AgnosticBenchmarkTrader();
            scenario.base.mint(address(scenario.makers[i]), 200_000 ether);
            scenario.makers[i].approve(scenario.base, scenario.exchange);
            scenario.quote.setBlacklisted(address(scenario.makers[i]), true);
        }

        for (uint256 i; i < LARGE_ORDER_COUNT; ++i) {
            uint128 price = BASE_PRICE + uint128(i) * LARGE_BENCHMARK_PRICE_STEP;
            uint128 quantity = _minimumTenUsdcQuantity(price);
            scenario.totalBaseQuantity += quantity;
            AgnosticBenchmarkTrader maker = scenario.makers[i % scenario.makers.length];
            maker.place(
                scenario.exchange,
                address(scenario.base),
                address(scenario.quote),
                ISpotCLOB.Side.Sell,
                price,
                quantity,
                uint64(i + 1)
            );
        }
    }

    function _record(bytes32 operation, uint256 gasUsed, uint256 quoteCount) private {
        emit BenchmarkGas(operation, gasUsed, quoteCount);
        emit log_named_bytes32("operation", operation);
        emit log_named_uint("gas used", gasUsed);
        emit log_named_uint("quotes consumed", quoteCount);
        emit log_named_uint("gas per quote", quoteCount == 0 ? 0 : gasUsed / quoteCount);
    }
}
