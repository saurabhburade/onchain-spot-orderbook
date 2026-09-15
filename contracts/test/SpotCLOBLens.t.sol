// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";

contract LensTrader {
    function approve(MockERC20 token, SpotCLOB book) external {
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
                expiry: 0,
                clientOrderId: 7
            })
        );
    }
}

contract SpotCLOBLensTest {
    SpotCLOB private book;
    SpotCLOBLens private lens;
    MockERC20 private base;
    MockERC20 private quote;
    LensTrader private seller;
    LensTrader private buyer;
    bytes32 private marketId;

    function setUp() public {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        base = new MockERC20("Base", "BASE", 18);
        quote = new MockERC20("USD Coin", "USDC", 6);
        factory.setQuoteToken(address(quote), true);
        address deployedBook;
        (marketId, deployedBook) =
            factory.createPair(address(base), address(quote), uint128(1 ether), 1, 1, 1_000);
        book = SpotCLOB(deployedBook);
        lens = new SpotCLOBLens();
        seller = new LensTrader();
        buyer = new LensTrader();
        base.mint(address(seller), 10 ether);
        quote.mint(address(buyer), 10_000);
        seller.approve(base, book);
        buyer.approve(quote, book);
    }

    function testBatchesMarketBookAndSequence() public {
        seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 2);
        buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 90, 3);

        SpotCLOBLens.MarketSnapshot memory snapshot =
            lens.getMarketSnapshot(book, address(base), address(quote), 2);
        require(snapshot.market.enabled && snapshot.market.lotSize == 1 ether, "wrong market");
        require(snapshot.sequence == 2, "wrong sequence");
        require(snapshot.bidExists && snapshot.bidPrice == 90 && snapshot.bidQuantity == 3, "bid");
        require(snapshot.askExists && snapshot.askPrice == 100 && snapshot.askQuantity == 2, "ask");
        require(snapshot.bids.length == 1 && snapshot.asks.length == 1, "wrong depth");
    }

    function testBatchesOrderAndUserOrderViews() public {
        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 2);

        SpotCLOBLens.OrderSnapshot memory snapshot = lens.getOrderSnapshot(book, orderId);
        require(snapshot.order.trader == address(seller), "wrong trader");
        require(snapshot.state.quantity == 2 && snapshot.resting, "wrong state");
        require(
            snapshot.previousOrderId == bytes32(0) && snapshot.nextOrderId == bytes32(0),
            "wrong links"
        );

        (ISpotCLOB.UserOrderView[] memory orders, bytes32 cursor) =
            lens.getUserOrders(book, marketId, address(seller), bytes32(0), 10, 1);
        require(orders.length == 1 && orders[0].orderId == orderId, "wrong orders");
        require(cursor == bytes32(0), "wrong cursor");
    }
}
