// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

contract InvariantMockERC20 {
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;

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

contract InvariantTrader {
    function approve(InvariantMockERC20 token, SpotCLOB exchange) external {
        token.approve(address(exchange), type(uint256).max);
    }

    function place(
        SpotCLOB exchange,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
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
                clientOrderId: 0
            })
        );
    }

    function cancel(SpotCLOB exchange, bytes32 orderId) external {
        exchange.cancelOrder(orderId);
    }

    function attemptCancel(SpotCLOB exchange, bytes32 orderId) external returns (bool success) {
        (success,) = address(exchange).call(abi.encodeCall(SpotCLOB.cancelOrder, (orderId)));
    }
}

contract SpotCLOBInvariantHandler {
    uint128 private constant LOT_SIZE = 1 ether;
    uint256 private constant INITIAL_BASE = 1_000 ether;
    uint256 private constant INITIAL_QUOTE = 1_000_000_000;

    SpotCLOB public immutable exchange;
    SpotCLOBFactory public immutable registry;
    InvariantMockERC20 public immutable base;
    InvariantMockERC20 public immutable quote;
    InvariantTrader public immutable sellerA;
    InvariantTrader public immutable sellerB;
    InvariantTrader public immutable buyer;
    InvariantTrader public immutable outsider;

    bytes32[] public orderIds;
    address[] private orderOwners;
    mapping(bytes32 orderId => bool seen) private _seenOrderId;

    constructor() {
        InvariantMockERC20 tokenA = new InvariantMockERC20();
        InvariantMockERC20 tokenB = new InvariantMockERC20();
        (base, quote) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
        sellerA = new InvariantTrader();
        sellerB = new InvariantTrader();
        buyer = new InvariantTrader();
        outsider = new InvariantTrader();

        registry = new SpotCLOBFactory();
        registry.setQuoteToken(address(quote), true);
        registry.setPairLotDecimals(address(base), address(quote), 0);
        (, address book) =
            registry.createPair(address(base), address(quote), 1, 1, uint24(type(uint24).max));
        exchange = SpotCLOB(book);

        base.mint(address(sellerA), INITIAL_BASE);
        base.mint(address(sellerB), INITIAL_BASE);
        quote.mint(address(buyer), INITIAL_QUOTE);

        sellerA.approve(base, exchange);
        sellerB.approve(base, exchange);
        buyer.approve(quote, exchange);
    }

    /// @notice A single state transition used by the invariant runner and deterministic fuzz tests.
    /// @dev Expected order failures are swallowed so arbitrary action sequences remain executable.
    function act(uint256 seed) external {
        uint256 operation = seed % 4;
        if (operation <= 1) {
            _place(seed, operation == 0);
        } else if (operation == 2) {
            _cancelOwned(seed);
        } else {
            _cancelUnauthorized(seed);
        }
    }

    function assertConservation() external view {
        uint256 baseTotal = _totalEscrow(address(base));
        uint256 quoteTotal = _totalEscrow(address(quote));
        require(base.balanceOf(address(exchange)) == baseTotal, "base conservation broken");
        require(quote.balanceOf(address(exchange)) == quoteTotal, "quote conservation broken");
        _assertBookMatchesOrders();
    }

    function _place(uint256 seed, bool sell) private {
        InvariantTrader trader = sell ? ((seed >> 1) & 1 == 0 ? sellerA : sellerB) : buyer;
        uint128 price = uint128(1 + ((seed >> 8) % 12));
        uint128 quantity = uint128(1 + ((seed >> 20) % 4));

        try trader.place(
            exchange,
            address(base),
            address(quote),
            sell ? ISpotCLOB.Side.Sell : ISpotCLOB.Side.Buy,
            price,
            quantity
        ) returns (
            bytes32 id
        ) {
            require(!_seenOrderId[id], "duplicate order id");
            _seenOrderId[id] = true;
            orderIds.push(id);
            orderOwners.push(address(trader));
        } catch { }
    }

    function _cancelOwned(uint256 seed) private {
        uint256 length = orderIds.length;
        if (length == 0) return;
        uint256 index = (seed >> 8) % length;
        try InvariantTrader(orderOwners[index]).cancel(exchange, orderIds[index]) { } catch { }
    }

    function _cancelUnauthorized(uint256 seed) private {
        uint256 length = orderIds.length;
        if (length == 0) return;
        uint256 index = (seed >> 8) % length;
        outsider.attemptCancel(exchange, orderIds[index]);
    }

    function _totalEscrow(address asset) private view returns (uint256 total) {
        total += _lockedBalance(address(sellerA), asset);
        total += _lockedBalance(address(sellerB), asset);
        total += _lockedBalance(address(buyer), asset);
        total += _lockedBalance(address(outsider), asset);
    }

    function _lockedBalance(address account, address asset) private view returns (uint256 locked) {
        (, locked,) = exchange.balanceOf(account, asset);
    }

    function _assertBookMatchesOrders() private view {
        bool expectedBid;
        bool expectedAsk;
        uint128 expectedBidPrice;
        uint128 expectedAskPrice;
        uint128 expectedBidQuantity;
        uint128 expectedAskQuantity;
        uint128[13] memory bidLiquidity;
        uint128[13] memory askLiquidity;

        for (uint256 i; i < orderIds.length; ++i) {
            (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
                exchange.getOrder(orderIds[i]);
            (,, bool resting) = exchange.getOrderLinks(orderIds[i]);
            if (
                state.status != ISpotCLOB.OrderStatus.Open
                    && state.status != ISpotCLOB.OrderStatus.PartiallyFilled
            ) {
                require(!resting, "closed order still linked");
                if (state.status == ISpotCLOB.OrderStatus.Filled) {
                    require(
                        state.filledQuantity == state.quantity,
                        "filled order has remaining quantity"
                    );
                }
                continue;
            }
            require(resting, "open order is not linked");

            uint128 remaining = state.quantity - state.filledQuantity;
            if (order.side == ISpotCLOB.Side.Buy) {
                bidLiquidity[order.price] += remaining;
                if (!expectedBid || order.price > expectedBidPrice) {
                    expectedBid = true;
                    expectedBidPrice = order.price;
                    expectedBidQuantity = remaining;
                } else if (order.price == expectedBidPrice) {
                    expectedBidQuantity += remaining;
                }
            } else if (!expectedAsk || order.price < expectedAskPrice) {
                askLiquidity[order.price] += remaining;
                expectedAsk = true;
                expectedAskPrice = order.price;
                expectedAskQuantity = remaining;
            } else if (order.price == expectedAskPrice) {
                askLiquidity[order.price] += remaining;
                expectedAskQuantity += remaining;
            } else {
                askLiquidity[order.price] += remaining;
            }
        }

        for (uint128 price = 1; price <= 12; ++price) {
            _assertLevelLiquidity(ISpotCLOB.Side.Buy, price, bidLiquidity[price]);
            _assertLevelLiquidity(ISpotCLOB.Side.Sell, price, askLiquidity[price]);
        }

        (
            bool actualBid,
            uint128 actualBidPrice,
            uint128 actualBidQuantity,
            bool actualAsk,
            uint128 actualAskPrice,
            uint128 actualAskQuantity
        ) = exchange.getBestPrices(registry.pairId(address(base), address(quote)));
        require(actualBid == expectedBid, "bid existence mismatch");
        require(actualAsk == expectedAsk, "ask existence mismatch");
        if (expectedBid) {
            require(actualBidPrice == expectedBidPrice, "best bid mismatch");
            require(actualBidQuantity == expectedBidQuantity, "bid quantity mismatch");
        }
        if (expectedAsk) {
            require(actualAskPrice == expectedAskPrice, "best ask mismatch");
            require(actualAskQuantity == expectedAskQuantity, "ask quantity mismatch");
        }
    }

    function _assertLevelLiquidity(ISpotCLOB.Side side, uint128 price, uint128 expected)
        private
        view
    {
        bytes32 id = exchange.marketId(address(base), address(quote));
        (uint128 actual,,) = exchange.getPriceLevel(id, side, price);
        require(actual == expected, "price-level sum mismatch");
        require(
            exchange.isPriceLevelActive(id, side, price) == (expected != 0),
            "bitmap membership mismatch"
        );
    }
}

contract SpotCLOBInvariantTest {
    uint128 private constant LOT_SIZE = 1 ether;
    uint256 private constant INITIAL_BASE = 1_000 ether;
    uint256 private constant INITIAL_QUOTE = 1_000_000_000;

    SpotCLOB private exchange;
    SpotCLOBFactory private registry;
    InvariantMockERC20 private base;
    InvariantMockERC20 private quote;
    InvariantTrader private sellerA;
    InvariantTrader private sellerB;
    InvariantTrader private buyer;
    InvariantTrader private outsider;
    SpotCLOBInvariantHandler private handler;

    function setUp() public {
        InvariantMockERC20 tokenA = new InvariantMockERC20();
        InvariantMockERC20 tokenB = new InvariantMockERC20();
        (base, quote) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
        sellerA = new InvariantTrader();
        sellerB = new InvariantTrader();
        buyer = new InvariantTrader();
        outsider = new InvariantTrader();
        handler = new SpotCLOBInvariantHandler();

        registry = new SpotCLOBFactory();
        registry.setQuoteToken(address(quote), true);
        registry.setPairLotDecimals(address(base), address(quote), 0);
        (, address book) =
            registry.createPair(address(base), address(quote), 1, 1, uint24(type(uint24).max));
        exchange = SpotCLOB(book);
        _fundAndApprove(sellerA, address(base), INITIAL_BASE);
        _fundAndApprove(sellerB, address(base), INITIAL_BASE);
        _fundAndApprove(buyer, address(quote), INITIAL_QUOTE);
    }

    /// @notice Foundry discovers this convention without importing forge-std.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function testFuzz_BitmapExtremaAcrossAllHierarchyBoundaries(uint256 seed) public {
        uint24[8] memory ticks = [
            uint24(1),
            uint24(255),
            uint24(256),
            uint24(257),
            uint24(65_535),
            uint24(65_536),
            uint24(65_537),
            type(uint24).max
        ];
        bytes32[8] memory askIds;
        uint256 offset = seed % ticks.length;

        for (uint256 i; i < ticks.length; ++i) {
            uint256 index = (i + offset) % ticks.length;
            askIds[index] = _place(sellerA, ISpotCLOB.Side.Sell, ticks[index], 1);
        }

        for (uint256 i; i < ticks.length; ++i) {
            _assertBest(false, 0, 0, true, ticks[i], 1);
            sellerA.cancel(exchange, askIds[i]);
        }
        _assertEmptyBook();

        bytes32[8] memory bidIds;
        for (uint256 i; i < ticks.length; ++i) {
            uint256 index = (i + offset) % ticks.length;
            bidIds[index] = _place(buyer, ISpotCLOB.Side.Buy, ticks[index], 1);
        }

        for (uint256 i = ticks.length; i > 0; --i) {
            uint256 index = i - 1;
            _assertBest(true, ticks[index], 1, false, 0, 0);
            buyer.cancel(exchange, bidIds[index]);
        }
        _assertEmptyBook();
        _assertConservation();
    }

    function testNonCrossedOrdersRestAndMatchingRemainsFIFO() public {
        bytes32 firstAsk = _place(sellerA, ISpotCLOB.Side.Sell, 100, 2);
        bytes32 secondAsk = _place(sellerB, ISpotCLOB.Side.Sell, 100, 3);
        bytes32 restingBid = _place(buyer, ISpotCLOB.Side.Buy, 90, 2);
        bytes32 higherAsk = _place(sellerA, ISpotCLOB.Side.Sell, 110, 1);
        _assertBest(true, 90, 2, true, 100, 5);
        _assertLevel(100, ISpotCLOB.Side.Sell, 5, firstAsk, secondAsk);
        _assertConservation();

        bytes32 taker = _place(buyer, ISpotCLOB.Side.Buy, 100, 4);
        _assertOrder(firstAsk, 2, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(secondAsk, 2, ISpotCLOB.OrderStatus.PartiallyFilled);
        _assertOrder(taker, 4, ISpotCLOB.OrderStatus.Filled);
        _assertBest(true, 90, 2, true, 100, 1);
        _assertLevel(100, ISpotCLOB.Side.Sell, 1, secondAsk, secondAsk);
        _assertConservation();

        sellerB.cancel(exchange, secondAsk);
        _assertBest(true, 90, 2, true, 110, 1);
        _assertLevel(100, ISpotCLOB.Side.Sell, 0, bytes32(0), bytes32(0));
        buyer.cancel(exchange, restingBid);
        sellerA.cancel(exchange, higherAsk);
        _assertEmptyBook();
        _assertConservation();
    }

    function testCancellationIsOwnerOnly() public {
        bytes32 orderId = _place(sellerA, ISpotCLOB.Side.Sell, 200, 3);
        (,, uint256 totalBefore) = exchange.balanceOf(address(sellerA), address(base));
        require(!outsider.attemptCancel(exchange, orderId), "unauthorized cancellation succeeded");
        _assertOrder(orderId, 0, ISpotCLOB.OrderStatus.Open);
        (,, uint256 totalAfter) = exchange.balanceOf(address(sellerA), address(base));
        require(totalAfter == totalBefore, "unauthorized call changed balance");
        _assertBest(false, 0, 0, true, 200, 3);

        sellerA.cancel(exchange, orderId);
        _assertOrder(orderId, 0, ISpotCLOB.OrderStatus.Cancelled);
        _assertEmptyBook();
        _assertConservation();
    }

    function testFuzz_StateTransitionsConserveAccountingAndExtrema(uint256 seed) public {
        for (uint256 i; i < 24; ++i) {
            handler.act(uint256(keccak256(abi.encode(seed, i))));
        }
        handler.assertConservation();
    }

    function invariant_StatefulHandlerConservesAccountingAndBookExtrema() public view {
        handler.assertConservation();
    }

    function _fundAndApprove(InvariantTrader trader, address asset, uint256 amount) private {
        if (asset == address(base)) base.mint(address(trader), amount);
        else quote.mint(address(trader), amount);
        if (asset == address(base)) trader.approve(base, exchange);
        else trader.approve(quote, exchange);
    }

    function _place(InvariantTrader trader, ISpotCLOB.Side side, uint128 price, uint128 quantity)
        private
        returns (bytes32)
    {
        return trader.place(exchange, address(base), address(quote), side, price, quantity);
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

    function _assertBest(
        bool expectedBid,
        uint128 expectedBidPrice,
        uint128 expectedBidQuantity,
        bool expectedAsk,
        uint128 expectedAskPrice,
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
        require(bidExists == expectedBid, "wrong bid existence");
        require(askExists == expectedAsk, "wrong ask existence");
        if (expectedBid) {
            require(bidPrice == expectedBidPrice, "wrong bid price");
            require(bidQuantity == expectedBidQuantity, "wrong bid quantity");
        }
        if (expectedAsk) {
            require(askPrice == expectedAskPrice, "wrong ask price");
            require(askQuantity == expectedAskQuantity, "wrong ask quantity");
        }
    }

    function _assertEmptyBook() private view {
        _assertBest(false, 0, 0, false, 0, 0);
    }

    function _assertLevel(
        uint128 price,
        ISpotCLOB.Side side,
        uint128 expectedQuantity,
        bytes32 expectedHead,
        bytes32 expectedTail
    ) private view {
        (uint128 quantity, bytes32 head, bytes32 tail) =
            exchange.getPriceLevel(_poolId(), side, price);
        require(quantity == expectedQuantity, "wrong price level quantity");
        require(head == expectedHead, "wrong price level head");
        require(tail == expectedTail, "wrong price level tail");
        require(
            exchange.isPriceLevelActive(_poolId(), side, price) == (expectedQuantity != 0),
            "bitmap and level disagree"
        );
    }

    function _poolId() private view returns (bytes32) {
        return exchange.marketId(address(base), address(quote));
    }

    function _assertConservation() private view {
        uint256 baseTotal = _totalEscrow(address(base));
        uint256 quoteTotal = _totalEscrow(address(quote));
        require(base.balanceOf(address(exchange)) == baseTotal, "base conservation broken");
        require(quote.balanceOf(address(exchange)) == quoteTotal, "quote conservation broken");
    }

    function _totalEscrow(address asset) private view returns (uint256 total) {
        total += _lockedBalance(address(sellerA), asset);
        total += _lockedBalance(address(sellerB), asset);
        total += _lockedBalance(address(buyer), asset);
        total += _lockedBalance(address(outsider), asset);
    }

    function _lockedBalance(address account, address asset) private view returns (uint256 locked) {
        (, locked,) = exchange.balanceOf(account, asset);
    }
}

/*
 * The public checks above cover extrema, level totals, bitmap membership, FIFO head/tail
 * transitions, linked/closed lifecycle state, and custody conservation. Raw leaf/middle/root
 * words intentionally remain an implementation detail; membership and sorted traversal exercise
 * their externally meaningful behavior without exposing the storage layout.
 */
