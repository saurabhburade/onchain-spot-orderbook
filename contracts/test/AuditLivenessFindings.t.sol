// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

interface AuditLivenessVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract AuditLivenessToken {
    uint8 public immutable decimals;
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

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

contract AuditLivenessFindingsTest {
    AuditLivenessVm private constant vm =
        AuditLivenessVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 private constant PRICE = 1e18;
    uint128 private constant QUANTITY = 1e18;
    address private constant MAKER = address(0xA11CE);
    address private constant BIDDER = address(0xB0B);
    address private constant SELLER = address(0xCA401);

    SpotCLOBFactory private factory;
    SpotCLOB private book;
    AuditLivenessToken private base;
    AuditLivenessToken private quote;
    bytes32 private poolId;

    function setUp() public {
        factory = new SpotCLOBFactory();
        base = new AuditLivenessToken(18);
        quote = new AuditLivenessToken(6);
        factory.setQuoteToken(address(quote), true);
        address deployed;
        (poolId, deployed) = factory.createPairWithFee(address(base), address(quote), 10);
        book = SpotCLOB(deployed);
    }

    /// @dev H-01 regression: the limit-order ABI has no expiry and a resting GTC order remains
    /// matchable regardless of elapsed time.
    function testGtcOrderRemainsMatchableAfterTimePasses() public {
        base.mint(MAKER, QUANTITY);
        quote.mint(BIDDER, 2e6);
        _approve(MAKER, base);
        _approve(BIDDER, quote);
        bytes32 ask = _placeDefault(MAKER, ISpotCLOB.Side.Sell, PRICE, QUANTITY);

        vm.warp(block.timestamp + 365 days);
        _placeDefault(BIDDER, ISpotCLOB.Side.Buy, PRICE, QUANTITY);

        (, ISpotCLOB.OrderState memory state) = book.getOrder(ask);
        require(state.status == ISpotCLOB.OrderStatus.Filled, "GTC order became unmatchable");
    }

    /// @dev M-01 regression: resting makers pay their snapshotted fee while a new taker pays the
    /// current fee, so raising the market fee cannot strand an older bid at the head of the book.
    function testFeeIncreaseDoesNotBlockRestingBidFromMarketSell() public {
        base.mint(SELLER, QUANTITY);
        quote.mint(BIDDER, 2e6);
        _approve(SELLER, base);
        _approve(BIDDER, quote);

        bytes32 bid = _placeDefault(BIDDER, ISpotCLOB.Side.Buy, PRICE, QUANTITY);
        factory.setPairTradingFeeBps(address(base), address(quote), 20);

        _marketSell(SELLER, QUANTITY);

        (uint128 quantityAfter, bytes32 headAfter, bytes32 tailAfter) =
            book.getPriceLevel(poolId, ISpotCLOB.Side.Buy, PRICE);
        require(
            quantityAfter == 0 && headAfter == bytes32(0) && tailAfter == bytes32(0),
            "filled bid remained on the book"
        );
        (, ISpotCLOB.OrderState memory bidAfter) = book.getOrder(bid);
        require(
            bidAfter.status == ISpotCLOB.OrderStatus.Filled && bidAfter.filledQuantity == QUANTITY,
            "old bid did not fill"
        );
        require(quote.balanceOf(SELLER) == 998_000, "taker did not pay the current fee");
        require(base.balanceOf(BIDDER) == QUANTITY, "maker did not receive base");
        require(
            book.accruedTradingFees(address(quote)) == 3_000,
            "maker and taker fees used the wrong rates"
        );
    }

    function _approve(address trader, AuditLivenessToken token) private {
        vm.prank(trader);
        token.approve(address(book), type(uint256).max);
    }

    function _placeDefault(address trader, ISpotCLOB.Side side, uint128 price, uint128 quantity)
        private
        returns (bytes32)
    {
        vm.prank(trader);
        return book.placeLimitOrder(_order(trader, side, price, quantity));
    }

    function _marketSell(address trader, uint128 quantity) private {
        vm.prank(trader);
        book.executeMarketOrder(
            ISpotCLOB.MarketOrder({
                trader: trader,
                baseAsset: address(base),
                quoteAsset: address(quote),
                side: ISpotCLOB.Side.Sell,
                quantity: quantity,
                priceLimit: 0,
                minFillQuantity: quantity,
                minReceive: 0,
                clientOrderId: 0
            }),
            64
        );
    }

    function _order(address trader, ISpotCLOB.Side side, uint128 price, uint128 quantity)
        private
        view
        returns (ISpotCLOB.LimitOrder memory)
    {
        return ISpotCLOB.LimitOrder({
            trader: trader,
            baseAsset: address(base),
            quoteAsset: address(quote),
            side: side,
            price: price,
            quantity: quantity,
            clientOrderId: 0
        });
    }
}
