// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

interface FindingToken {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract FindingERC20 {
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

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        virtual
        returns (bool)
    {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev The model only blocks transfers to a blacklisted receiver, which is the USDC behavior
/// needed by these reproductions.
contract ReceiverBlocklistToken is FindingERC20 {
    mapping(address account => bool blocked) public blacklisted;

    function setBlacklisted(address account, bool blocked) external {
        blacklisted[account] = blocked;
    }

    function _move(address from, address to, uint256 amount) internal override {
        if (blacklisted[to]) revert("blacklisted receiver");
        super._move(from, to, amount);
    }
}

contract NegativeRebaseToken is FindingERC20 {
    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}

/// @dev Pulls credit the requested amount but charges the sender an extra atom on every move.
contract SenderSurchargeToken is FindingERC20 {
    uint256 public constant SURCHARGE = 1;

    function _move(address from, address to, uint256 amount) internal override {
        balanceOf[from] -= amount + SURCHARGE;
        balanceOf[to] += amount;
    }
}

contract FindingTrader {
    function approve(FindingERC20 token, SpotCLOB book) external {
        token.approve(address(book), type(uint256).max);
    }

    function place(
        SpotCLOB book,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
    ) external returns (bytes32 orderId) {
        return book.placeLimitOrder(
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

    function placeWithMaxBookSteps(
        SpotCLOB book,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint32 maxBookSteps
    ) external returns (bytes32 orderId) {
        return book.placeLimitOrderWithMaxBookSteps(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                price: price,
                quantity: quantity,
                expiry: 0,
                clientOrderId: 0
            }),
            maxBookSteps
        );
    }

    function attemptPlace(
        SpotCLOB book,
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
        (success,) = address(book).call(abi.encodeCall(SpotCLOB.placeLimitOrder, (order)));
    }

    function attemptCancel(SpotCLOB book, bytes32 orderId) external returns (bool success) {
        (success,) = address(book).call(abi.encodeCall(SpotCLOB.cancelOrder, (orderId)));
    }

    function closeQuarantined(SpotCLOB book, bytes32 orderId, address receiver) external {
        book.closeQuarantinedOrder(orderId, receiver);
    }

    function attemptCloseQuarantined(SpotCLOB book, bytes32 orderId, address receiver)
        external
        returns (bool success)
    {
        (success,) = address(book)
            .call(abi.encodeCall(SpotCLOB.closeQuarantinedOrder, (orderId, receiver)));
    }
}

contract AuditTokenBehaviorFindingsTest {
    uint256 private constant ONE = 1 ether;
    uint256 private constant SURCHARGE = 1;
    uint256 private constant BLOCKED_ORDER_COUNT = 100;

    event log_named_uint(string key, uint256 value);

    function testM02BlockedMakerIsQuarantinedAndNextMakerFills() public {
        ReceiverBlocklistToken quote = new ReceiverBlocklistToken();
        FindingERC20 base = new FindingERC20();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader blockedMaker = new FindingTrader();
        FindingTrader validMaker = new FindingTrader();
        FindingTrader buyer = new FindingTrader();

        base.mint(address(blockedMaker), ONE);
        base.mint(address(validMaker), ONE);
        quote.mint(address(buyer), 1_000);
        blockedMaker.approve(base, book);
        validMaker.approve(base, book);
        buyer.approve(quote, book);

        bytes32 blockedAsk =
            blockedMaker.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        bytes32 validAsk =
            validMaker.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        quote.setBlacklisted(address(blockedMaker), true);

        bytes32 taker = buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1);

        _assertOrderStatus(book, blockedAsk, ISpotCLOB.OrderStatus.Quarantined, 0);
        _assertOrderStatus(book, validAsk, ISpotCLOB.OrderStatus.Filled, 1);
        _assertOrderStatus(book, taker, ISpotCLOB.OrderStatus.Filled, 1);
        _assertHead(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, bytes32(0), 0);
        require(base.balanceOf(address(buyer)) == ONE, "buyer did not receive valid fill");
        require(quote.balanceOf(address(validMaker)) == 100, "valid maker was not paid");

        (bytes32 previous, bytes32 next, bool resting) = book.getOrderLinks(blockedAsk);
        require(
            previous == bytes32(0) && next == bytes32(0) && !resting,
            "quarantined maker remains linked"
        );
    }

    function testM02OnlyOwnerCanCloseQuarantineToAlternateReceiver() public {
        ReceiverBlocklistToken base = new ReceiverBlocklistToken();
        ReceiverBlocklistToken quote = new ReceiverBlocklistToken();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader blockedMaker = new FindingTrader();
        FindingTrader buyer = new FindingTrader();
        address receiver = address(0xBEEF);

        base.mint(address(blockedMaker), ONE);
        quote.mint(address(buyer), 1_000);
        blockedMaker.approve(base, book);
        buyer.approve(quote, book);
        bytes32 blockedAsk =
            blockedMaker.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        quote.setBlacklisted(address(blockedMaker), true);
        buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1);
        _assertOrderStatus(book, blockedAsk, ISpotCLOB.OrderStatus.Quarantined, 0);

        require(
            !buyer.attemptCloseQuarantined(book, blockedAsk, receiver),
            "non-owner closed quarantine"
        );
        base.setBlacklisted(address(blockedMaker), true);
        require(
            !blockedMaker.attemptCloseQuarantined(book, blockedAsk, address(blockedMaker)),
            "blacklisted receiver accepted refund"
        );
        _assertOrderStatus(book, blockedAsk, ISpotCLOB.OrderStatus.Quarantined, 0);

        blockedMaker.closeQuarantined(book, blockedAsk, receiver);
        _assertOrderStatus(book, blockedAsk, ISpotCLOB.OrderStatus.Cancelled, 0);
        require(base.balanceOf(receiver) == ONE, "alternate receiver did not receive full escrow");
        (, uint256 locked,) = book.balanceOf(address(blockedMaker), address(base));
        require(locked == 0, "closed quarantine retained locked accounting");
    }

    function testM02FailedTakerPayoutDoesNotQuarantineMakerDuringSelfTrade() public {
        ReceiverBlocklistToken base = new ReceiverBlocklistToken();
        FindingERC20 quote = new FindingERC20();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader trader = new FindingTrader();

        base.mint(address(trader), ONE);
        quote.mint(address(trader), 1_000);
        trader.approve(base, book);
        trader.approve(quote, book);
        bytes32 ask = trader.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        base.setBlacklisted(address(trader), true);

        require(
            !trader.attemptPlace(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1),
            "blocked taker payout unexpectedly succeeded"
        );
        _assertOrderStatus(book, ask, ISpotCLOB.OrderStatus.Open, 0);
        _assertHead(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, ask, 1);
    }

    function testGasM02HundredBlockedOrdersAreUnlinkedDuringMatching() public {
        ReceiverBlocklistToken quote = new ReceiverBlocklistToken();
        FindingERC20 base = new FindingERC20();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader blockedMaker = new FindingTrader();
        FindingTrader validMaker = new FindingTrader();
        FindingTrader buyer = new FindingTrader();

        base.mint(address(blockedMaker), BLOCKED_ORDER_COUNT * ONE);
        base.mint(address(validMaker), 2 * ONE);
        quote.mint(address(buyer), 1_000);
        blockedMaker.approve(base, book);
        validMaker.approve(base, book);
        buyer.approve(quote, book);

        bytes32[] memory blockedOrders = new bytes32[](BLOCKED_ORDER_COUNT);
        for (uint256 i; i < BLOCKED_ORDER_COUNT; ++i) {
            blockedOrders[i] = blockedMaker.place(
                book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1
            );
        }
        bytes32 firstValid =
            validMaker.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        quote.setBlacklisted(address(blockedMaker), true);

        uint256 gasBefore = gasleft();
        buyer.placeWithMaxBookSteps(
            book,
            address(base),
            address(quote),
            ISpotCLOB.Side.Buy,
            100,
            1,
            uint32(BLOCKED_ORDER_COUNT + 1)
        );
        uint256 unlinkAndMatchGas = gasBefore - gasleft();
        emit log_named_uint("unlink 100 blocked and fill next gas", unlinkAndMatchGas);
        require(unlinkAndMatchGas < 30_000_000, "100-order unlink exceeds block budget");

        _assertOrderStatus(book, blockedOrders[0], ISpotCLOB.OrderStatus.Quarantined, 0);
        _assertOrderStatus(
            book, blockedOrders[BLOCKED_ORDER_COUNT - 1], ISpotCLOB.OrderStatus.Quarantined, 0
        );
        _assertOrderStatus(book, firstValid, ISpotCLOB.OrderStatus.Filled, 1);

        {
            (bytes32 previous, bytes32 next, bool resting) = book.getOrderLinks(blockedOrders[0]);
            require(
                previous == bytes32(0) && next == bytes32(0) && !resting,
                "first quarantine remains linked"
            );
        }
        {
            (bytes32 previous, bytes32 next, bool resting) =
                book.getOrderLinks(blockedOrders[BLOCKED_ORDER_COUNT - 1]);
            require(
                previous == bytes32(0) && next == bytes32(0) && !resting,
                "last quarantine remains linked"
            );
        }

        // A fresh executable order matches without traversing the removed makers.
        bytes32 secondValid =
            validMaker.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        gasBefore = gasleft();
        buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1);
        uint256 nextMatchGas = gasBefore - gasleft();
        emit log_named_uint("next match after immediate unlink gas", nextMatchGas);
        require(nextMatchGas < 1_500_000, "next match traversed removed makers");
        _assertOrderStatus(book, secondValid, ISpotCLOB.OrderStatus.Filled, 1);
    }

    function testM03NegativeRebaseBlocksTradingAndCancelsProRata() public {
        NegativeRebaseToken base = new NegativeRebaseToken();
        FindingERC20 quote = new FindingERC20();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader firstSeller = new FindingTrader();
        FindingTrader secondSeller = new FindingTrader();
        FindingTrader buyer = new FindingTrader();

        base.mint(address(firstSeller), 2 * ONE);
        base.mint(address(secondSeller), 2 * ONE);
        quote.mint(address(buyer), 1_000);
        firstSeller.approve(base, book);
        secondSeller.approve(base, book);
        buyer.approve(quote, book);

        bytes32 firstAsk =
            firstSeller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        bytes32 secondAsk =
            secondSeller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);

        base.setBalance(address(book), ONE);

        // Rebase changes only token holdings; the book still records both nominal liabilities.
        _assertOpenOrder(book, firstAsk, 1);
        _assertOpenOrder(book, secondAsk, 1);
        (, uint256 firstLocked,) = book.balanceOf(address(firstSeller), address(base));
        (, uint256 secondLocked,) = book.balanceOf(address(secondSeller), address(base));
        require(firstLocked == ONE && secondLocked == ONE, "nominal escrow changed on rebase");
        require(book.totalEscrowLiability(address(base)) == 2 * ONE, "wrong total liability");

        require(
            !buyer.attemptPlace(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1),
            "insolvent market accepted matching"
        );
        _assertHead(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, firstAsk, 2);

        require(firstSeller.attemptCancel(book, firstAsk), "first recovery close failed");
        require(
            base.balanceOf(address(firstSeller)) == 3 * ONE / 2,
            "first order did not receive half of nominal escrow"
        );
        require(book.totalEscrowLiability(address(base)) == ONE, "first claim not removed");
        require(base.balanceOf(address(book)) == ONE / 2, "first claim broke recovery ratio");

        require(secondSeller.attemptCancel(book, secondAsk), "second recovery close failed");
        require(
            base.balanceOf(address(secondSeller)) == 3 * ONE / 2,
            "second order did not receive half of nominal escrow"
        );
        require(book.totalEscrowLiability(address(base)) == 0, "liability remained after closes");
        require(base.balanceOf(address(book)) == 0, "unexpected base balance");
        _assertHead(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, bytes32(0), 0);

        // There is no stored pause flag: trading becomes available again once liabilities clear.
        firstSeller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
    }

    function testM03ProRataCloseUsesFullPrecision() public {
        NegativeRebaseToken base = new NegativeRebaseToken();
        FindingERC20 quote = new FindingERC20();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader seller = new FindingTrader();
        uint128 quantity = type(uint128).max;
        uint256 nominalEscrow = uint256(quantity) * ONE;
        uint256 recoverable = nominalEscrow / 2;

        base.mint(address(seller), nominalEscrow);
        seller.approve(base, book);
        bytes32 ask =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, quantity);
        base.setBalance(address(book), recoverable);

        require(seller.attemptCancel(book, ask), "full-precision recovery close failed");
        require(base.balanceOf(address(seller)) == recoverable, "wrong full-width payout");
        require(book.totalEscrowLiability(address(base)) == 0, "full-width claim remained");
        require(base.balanceOf(address(book)) == 0, "full-width assets remained");
    }

    function testKnownIssue_L02SenderSurchargeBreaksPushValidation() public {
        SenderSurchargeToken base = new SenderSurchargeToken();
        FindingERC20 quote = new FindingERC20();
        (SpotCLOB book,) = _deployPair(address(base), address(quote));
        FindingTrader seller = new FindingTrader();

        base.mint(address(seller), 2 * ONE);
        seller.approve(base, book);
        bytes32 ask = seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);
        uint256 sellerBalanceBeforeCancel = base.balanceOf(address(seller));
        base.mint(address(book), SURCHARGE);

        // Pull validation sees the requested amount arrive, but push validation sees the sender
        // fee.
        require(!seller.attemptCancel(book, ask), "sender-surcharge payout accepted");
        _assertHead(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, ask, 1);
        _assertOpenOrder(book, ask, 1);
        (, uint256 locked,) = book.balanceOf(address(seller), address(base));
        require(locked == ONE, "escrow changed after failed payout");
        require(
            base.balanceOf(address(seller)) == sellerBalanceBeforeCancel,
            "failed payout changed sender balance"
        );
        require(
            base.balanceOf(address(book)) == ONE + SURCHARGE,
            "failed payout changed contract balance"
        );
    }

    function _deployPair(address base, address quote) private returns (SpotCLOB book, bytes32 id) {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        factory.setQuoteToken(quote, true);
        factory.setPairLotDecimals(base, quote, 0);
        address deployed;
        (id, deployed) = factory.createPair(base, quote, 1, 1, 100_000);
        book = SpotCLOB(deployed);
    }

    function _assertHead(
        SpotCLOB book,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        bytes32 expectedHead,
        uint128 expectedQuantity
    ) private view {
        bytes32 id = book.marketId(base, quote);
        (uint128 totalQuantity, bytes32 head,) = book.getPriceLevel(id, side, price);
        require(totalQuantity == expectedQuantity, "FIFO level quantity changed");
        require(head == expectedHead, "FIFO head changed");
    }

    function _assertOpenOrder(SpotCLOB book, bytes32 orderId, uint128 expectedQuantity)
        private
        view
    {
        (, ISpotCLOB.OrderState memory state) = book.getOrder(orderId);
        require(state.status == ISpotCLOB.OrderStatus.Open, "order is not open");
        require(state.quantity == expectedQuantity && state.filledQuantity == 0, "order changed");
    }

    function _assertOrderStatus(
        SpotCLOB book,
        bytes32 orderId,
        ISpotCLOB.OrderStatus expectedStatus,
        uint128 expectedFilled
    ) private view {
        (, ISpotCLOB.OrderState memory state) = book.getOrder(orderId);
        require(state.status == expectedStatus, "wrong order status");
        require(state.filledQuantity == expectedFilled, "wrong filled quantity");
    }
}
