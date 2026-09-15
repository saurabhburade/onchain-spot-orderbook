// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

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
                expiry: 0,
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
                clientOrderId: clientOrderId
            }),
            64
        );
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }
}

/// @notice Transaction-style gas benchmarks for the full uint128 price tree.
/// @dev Run with: forge test --match-path test/AgnosticGasBenchmark.t.sol --gas-report -vv
contract AgnosticGasBenchmarkTest {
    uint128 private constant ONE_TOKEN = 1 ether;
    uint128 private constant BASE_PRICE = 1 ether; // 1 USDC/token in priceX18.
    uint128 private constant PRICE_STEP = 1e15; // 0.001 USDC.

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
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, BASE_PRICE, ONE_TOKEN, 1
        );
        _record("place-first-level", beforeGas - gasleft(), 1);
    }

    function testGasPlaceSamePriceAndCancel() public {
        seller.place(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, BASE_PRICE, ONE_TOKEN, 1
        );
        uint256 beforeGas = gasleft();
        bytes32 second = seller.place(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, BASE_PRICE, ONE_TOKEN, 2
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
        lens.quoteAmount(exchange, address(base), address(quote), BASE_PRICE, ONE_TOKEN);
        _record("quote-amount", beforeGas - gasleft(), 1);
    }

    function testGasMarketBuyConsumesOneQuote() public {
        _seedAsks(1);
        uint256 beforeGas = gasleft();
        (, uint128 filled,) = buyer.market(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, ONE_TOKEN, 101
        );
        _record("market-buy-1", beforeGas - gasleft(), 1);
        require(filled == ONE_TOKEN, "wrong fill");
    }

    function testGasMarketBuyConsumesFiftyQuotes() public {
        _seedAsks(50);
        uint256 beforeGas = gasleft();
        (, uint128 filled,) = buyer.market(
            exchange, address(base), address(quote), ISpotCLOB.Side.Buy, 50 * ONE_TOKEN, 101
        );
        _record("market-buy-50", beforeGas - gasleft(), 50);
        require(filled == 50 * ONE_TOKEN, "wrong fill");
    }

    function testGasMarketSellConsumesFiftyQuotes() public {
        _seedBids(50);
        uint256 beforeGas = gasleft();
        (, uint128 filled,) = seller.market(
            exchange, address(base), address(quote), ISpotCLOB.Side.Sell, 50 * ONE_TOKEN, 201
        );
        _record("market-sell-50", beforeGas - gasleft(), 50);
        require(filled == 50 * ONE_TOKEN, "wrong fill");
    }

    function _seedAsks(uint256 count) private {
        for (uint256 i; i < count; ++i) {
            seller.place(
                exchange,
                address(base),
                address(quote),
                ISpotCLOB.Side.Sell,
                BASE_PRICE + uint128(i) * PRICE_STEP,
                ONE_TOKEN,
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
                ONE_TOKEN,
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
