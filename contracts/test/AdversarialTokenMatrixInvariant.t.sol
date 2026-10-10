// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

/// @dev ERC20 model whose pull tax, push tax, receiver blacklist, and book balance can be changed
/// independently. This lets one state machine compose the token behaviors instead of testing each
/// behavior only in isolation.
contract MatrixToken {
    uint256 private constant BPS_DENOMINATOR = 10_000;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;
    mapping(address account => bool blocked) public blacklisted;
    uint16 public transferFromTaxBps;
    uint16 public transferTaxBps;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

    function setTaxes(uint16 pullTaxBps, uint16 pushTaxBps) external {
        require(pullTaxBps < BPS_DENOMINATOR && pushTaxBps < BPS_DENOMINATOR, "invalid tax");
        transferFromTaxBps = pullTaxBps;
        transferTaxBps = pushTaxBps;
    }

    function setBlacklisted(address account, bool blocked) external {
        blacklisted[account] = blocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount, transferTaxBps);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount, transferFromTaxBps);
        return true;
    }

    function _move(address from, address to, uint256 amount, uint16 taxBps) private {
        if (blacklisted[to]) revert("blacklisted receiver");
        balanceOf[from] -= amount;
        uint256 tax = amount * taxBps / BPS_DENOMINATOR;
        balanceOf[to] += amount - tax;
    }
}

contract MatrixTrader {
    function approve(MatrixToken token, SpotCLOB book) external {
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
        return book.placeLimitOrderWithMaxBookSteps(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                price: price,
                quantity: quantity,
                clientOrderId: 0
            }),
            64
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
            clientOrderId: 0
        });
        (success,) = address(book)
            .call(abi.encodeCall(SpotCLOB.placeLimitOrderWithMaxBookSteps, (order, uint32(64))));
    }

    function cancel(SpotCLOB book, bytes32 orderId) external {
        book.cancelOrder(orderId);
    }

    function closeQuarantined(SpotCLOB book, bytes32 orderId, address receiver) external {
        book.closeQuarantinedOrder(orderId, receiver);
    }
}

contract AdversarialTokenMatrixHandler {
    uint256 private constant INITIAL_BASE = 10_000 ether;
    uint256 private constant INITIAL_QUOTE = 10_000_000_000;
    address private constant RECOVERY_RECEIVER = address(0xCAFE);

    SpotCLOB public immutable book;
    SpotCLOBFactory public immutable factory;
    MatrixToken public immutable base;
    MatrixToken public immutable quote;
    bytes32 public immutable poolId;

    MatrixTrader[4] private traders;
    uint128[5] private prices = [uint128(80_000), 90_000, 100_000, 110_000, 120_000];
    bytes32[] private orderIds;
    mapping(bytes32 id => address owner) private orderOwner;
    mapping(bytes32 id => uint128 filled) private priorFilled;
    mapping(bytes32 id => ISpotCLOB.OrderStatus status) private priorStatus;

    uint256 public placements;
    uint256 public cancellations;
    uint256 public quarantineCloses;
    uint256 public taxUpdates;
    uint256 public blacklistUpdates;
    uint256 public feeUpdates;
    uint256 public rebases;
    uint256 public insolvencyProbes;
    uint256 public recapitalizations;

    constructor() {
        factory = new SpotCLOBFactory();
        base = new MatrixToken();
        quote = new MatrixToken();
        factory.setQuoteToken(address(quote), true);
        factory.setPairLotDecimals(address(base), address(quote), 0);
        address deployed;
        (poolId, deployed) = factory.createPair(address(base), address(quote), 1, 1, 120_000);
        book = SpotCLOB(deployed);

        for (uint256 i; i < traders.length; ++i) {
            traders[i] = new MatrixTrader();
            base.mint(address(traders[i]), INITIAL_BASE);
            quote.mint(address(traders[i]), INITIAL_QUOTE);
            traders[i].approve(base, book);
            traders[i].approve(quote, book);
        }
    }

    /// @notice Mix token behavior, exchange fees, both order sides, fills, cancellation, recovery,
    /// and solvency transitions in one stateful target.
    function act(uint256 seed) external {
        uint256 operation = seed % 12;
        if (operation == 0) {
            _setTaxes(seed);
        } else if (operation == 1) {
            _setTradingFee(seed);
        } else if (operation <= 4) {
            _place(seed, operation == 2 ? ISpotCLOB.Side.Buy : ISpotCLOB.Side.Sell);
        } else if (operation == 5) {
            _cancel(seed);
        } else if (operation == 6) {
            _setBlacklist(seed, true);
        } else if (operation == 7) {
            _setBlacklist(seed, false);
        } else if (operation == 8) {
            _closeQuarantine(seed);
        } else if (operation <= 10) {
            _rebaseAndProbe(seed, operation == 9 ? base : quote);
        } else {
            _recapitalize();
        }
        _observeOrders();
    }

    function assertAccountingAndBook() external view {
        _assertAssetAccounting(base);
        _assertAssetAccounting(quote);
        for (uint256 i; i < prices.length; ++i) {
            _assertLevel(ISpotCLOB.Side.Buy, prices[i]);
            _assertLevel(ISpotCLOB.Side.Sell, prices[i]);
        }
    }

    function orderCount() external view returns (uint256) {
        return orderIds.length;
    }

    function _setTaxes(uint256 seed) private {
        MatrixToken token = (seed >> 8) & 1 == 0 ? base : quote;
        uint16[4] memory rates = [uint16(0), 2_500, 5_000, 7_500];
        uint16 pullTax = rates[(seed >> 16) % rates.length];
        uint16 pushTax = rates[(seed >> 24) % rates.length];
        token.setTaxes(pullTax, pushTax);
        ++taxUpdates;
    }

    function _setTradingFee(uint256 seed) private {
        factory.setPairTradingFeeBps(address(base), address(quote), uint16((seed >> 8) % 1_001));
        ++feeUpdates;
    }

    function _place(uint256 seed, ISpotCLOB.Side side) private {
        MatrixTrader trader = traders[(seed >> 8) % traders.length];
        uint128 price = prices[(seed >> 16) % prices.length];
        uint128 quantity = uint128(1 + ((seed >> 24) % 4));
        try trader.place(book, address(base), address(quote), side, price, quantity) returns (
            bytes32 id
        ) {
            require(orderOwner[id] == address(0), "duplicate order id");
            orderOwner[id] = address(trader);
            orderIds.push(id);
            (, ISpotCLOB.OrderState memory state) = book.getOrder(id);
            priorFilled[id] = state.filledQuantity;
            priorStatus[id] = state.status;
            ++placements;
        } catch { }
    }

    function _cancel(uint256 seed) private {
        if (orderIds.length == 0) return;
        bytes32 id = orderIds[(seed >> 8) % orderIds.length];
        (,, bool resting) = book.getOrderLinks(id);
        if (!resting) return;
        try MatrixTrader(orderOwner[id]).cancel(book, id) {
            ++cancellations;
        } catch { }
    }

    function _setBlacklist(uint256 seed, bool blocked) private {
        MatrixToken token = (seed >> 8) & 1 == 0 ? base : quote;
        token.setBlacklisted(address(traders[(seed >> 16) % traders.length]), blocked);
        ++blacklistUpdates;
    }

    function _closeQuarantine(uint256 seed) private {
        if (orderIds.length == 0) return;
        bytes32 id = orderIds[(seed >> 8) % orderIds.length];
        (, ISpotCLOB.OrderState memory state) = book.getOrder(id);
        if (state.status != ISpotCLOB.OrderStatus.Quarantined) return;
        try MatrixTrader(orderOwner[id]).closeQuarantined(book, id, RECOVERY_RECEIVER) {
            ++quarantineCloses;
        } catch { }
    }

    function _rebaseAndProbe(uint256 seed, MatrixToken token) private {
        uint256 liability = book.totalEscrowLiability(address(token));
        uint256 fees = book.accruedTradingFees(address(token));
        uint256 required = liability + fees;
        if (required < 2) return;

        token.setBalance(address(book), required / 2);
        ++rebases;

        uint256 baseLiabilityBefore = book.totalEscrowLiability(address(base));
        uint256 quoteLiabilityBefore = book.totalEscrowLiability(address(quote));
        MatrixTrader trader = traders[(seed >> 16) % traders.length];
        bool success = trader.attemptPlace(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, 120_000, 1
        );
        require(!success, "insolvent market accepted an order");
        require(
            book.totalEscrowLiability(address(base)) == baseLiabilityBefore
                && book.totalEscrowLiability(address(quote)) == quoteLiabilityBefore,
            "failed insolvency probe changed liabilities"
        );
        ++insolvencyProbes;
    }

    function _recapitalize() private {
        _recapitalizeAsset(base);
        _recapitalizeAsset(quote);
        ++recapitalizations;
    }

    function _recapitalizeAsset(MatrixToken token) private {
        uint256 required =
            book.totalEscrowLiability(address(token)) + book.accruedTradingFees(address(token));
        uint256 available = token.balanceOf(address(book));
        if (available < required) token.mint(address(book), required - available);
    }

    function _observeOrders() private {
        for (uint256 i; i < orderIds.length; ++i) {
            bytes32 id = orderIds[i];
            (, ISpotCLOB.OrderState memory state) = book.getOrder(id);
            require(
                state.filledQuantity >= priorFilled[id] && state.filledQuantity <= state.quantity,
                "filled quantity is not monotonic and bounded"
            );
            ISpotCLOB.OrderStatus previous = priorStatus[id];
            if (
                previous == ISpotCLOB.OrderStatus.Filled
                    || previous == ISpotCLOB.OrderStatus.Cancelled
            ) {
                require(state.status == previous, "terminal order changed status");
            } else if (previous == ISpotCLOB.OrderStatus.Quarantined) {
                require(
                    state.status == ISpotCLOB.OrderStatus.Quarantined
                        || state.status == ISpotCLOB.OrderStatus.Cancelled,
                    "quarantined order re-entered the book"
                );
            }
            priorFilled[id] = state.filledQuantity;
            priorStatus[id] = state.status;
        }
    }

    function _assertAssetAccounting(MatrixToken token) private view {
        uint256 totalLocked;
        for (uint256 i; i < traders.length; ++i) {
            (, uint256 locked,) = book.balanceOf(address(traders[i]), address(token));
            totalLocked += locked;
        }
        require(
            book.totalEscrowLiability(address(token)) == totalLocked,
            "aggregate liability differs from trader locks"
        );
    }

    function _assertLevel(ISpotCLOB.Side side, uint128 price) private view {
        uint128 expectedQuantity;
        bytes32 expectedHead;
        bytes32 expectedTail;

        for (uint256 i; i < orderIds.length; ++i) {
            bytes32 id = orderIds[i];
            (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
                book.getOrder(id);
            (bytes32 previous, bytes32 next, bool resting) = book.getOrderLinks(id);

            if (!resting) {
                require(previous == bytes32(0) && next == bytes32(0), "unlinked order has links");
                require(
                    state.status == ISpotCLOB.OrderStatus.Filled
                        || state.status == ISpotCLOB.OrderStatus.Cancelled
                        || state.status == ISpotCLOB.OrderStatus.Quarantined,
                    "open order is not resting"
                );
                continue;
            }

            require(
                state.status == ISpotCLOB.OrderStatus.Open
                    || state.status == ISpotCLOB.OrderStatus.PartiallyFilled,
                "closed order remains resting"
            );
            if (order.side != side || order.price != price) continue;
            require(previous == expectedTail, "FIFO predecessor mismatch");
            if (expectedTail == bytes32(0)) expectedHead = id;
            expectedTail = id;
            expectedQuantity += state.quantity - state.filledQuantity;
        }

        (uint128 quantity, bytes32 head, bytes32 tail) = book.getPriceLevel(poolId, side, price);
        require(
            quantity == expectedQuantity && head == expectedHead && tail == expectedTail,
            "price level differs from tracked orders"
        );
        require(
            book.isPriceLevelActive(poolId, side, price) == (expectedQuantity != 0),
            "price bitmap differs from level"
        );
    }
}

contract AdversarialTokenMatrixInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    AdversarialTokenMatrixHandler private handler;

    function setUp() public {
        handler = new AdversarialTokenMatrixHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        targets = new FuzzSelector[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = AdversarialTokenMatrixHandler.act.selector;
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariant_MixedTokenBehaviorsPreserveAccountingAndFIFO() public view {
        handler.assertAccountingAndBook();
    }

    function testFuzz_MixedTokenBehaviorTransitions(uint256 seed) public {
        for (uint256 i; i < 32; ++i) {
            handler.act(uint256(keccak256(abi.encode(seed, i))));
            handler.assertAccountingAndBook();
        }
    }
}

contract AdversarialTokenMatrixTest {
    uint256 private constant ONE = 1 ether;

    function testMatrix_TaxesFeesBlacklistCreateFillCancelAndRecover() public {
        (MatrixToken base, MatrixToken quote, SpotCLOB book, SpotCLOBFactory factory) = _deploy();
        MatrixTrader blockedMaker = new MatrixTrader();
        MatrixTrader validMaker = new MatrixTrader();
        MatrixTrader buyer = new MatrixTrader();
        address recoveryReceiver = address(0xBEEF);

        base.mint(address(blockedMaker), 10 * ONE);
        base.mint(address(validMaker), 10 * ONE);
        quote.mint(address(buyer), 1_000_000);
        blockedMaker.approve(base, book);
        validMaker.approve(base, book);
        buyer.approve(quote, book);

        factory.setPairTradingFeeBps(address(base), address(quote), 100);
        base.setTaxes(2_500, 2_000);
        quote.setTaxes(500, 1_000);

        bytes32 blockedAsk = blockedMaker.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, 100_000, 4
        );
        bytes32 validAsk = validMaker.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, 100_000, 4
        );
        quote.setBlacklisted(address(blockedMaker), true);
        factory.setPairTradingFeeBps(address(base), address(quote), 300);

        bytes32 taker =
            buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100_000, 3);

        _assertOrder(book, blockedAsk, 3, 0, ISpotCLOB.OrderStatus.Quarantined);
        _assertOrder(book, validAsk, 3, 2, ISpotCLOB.OrderStatus.PartiallyFilled);
        _assertOrder(book, taker, 2, 2, ISpotCLOB.OrderStatus.Filled);
        require(base.balanceOf(address(buyer)) == 16 * ONE / 10, "wrong taxed taker payout");
        require(quote.balanceOf(address(validMaker)) == 178_200, "wrong taxed maker payout");
        require(book.accruedTradingFees(address(quote)) == 8_000, "wrong maker/taker fees");
        require(book.totalEscrowLiability(address(base)) == 4 * ONE, "wrong base liability");
        require(book.totalEscrowLiability(address(quote)) == 0, "quote escrow remained");

        validMaker.cancel(book, validAsk);
        blockedMaker.closeQuarantined(book, blockedAsk, recoveryReceiver);
        require(book.totalEscrowLiability(address(base)) == 0, "base escrow remained");
        require(base.balanceOf(address(book)) == 0, "base assets remained");
        require(base.balanceOf(recoveryReceiver) == 24 * ONE / 10, "wrong recovery payout");
        require(quote.balanceOf(address(book)) == 8_000, "fees are not fully backed");
    }

    function testMatrix_BaseAndQuoteRebasesBlockTradingButAllowProRataCancellation() public {
        (MatrixToken base, MatrixToken quote, SpotCLOB book, SpotCLOBFactory factory) = _deploy();
        MatrixTrader sellerA = new MatrixTrader();
        MatrixTrader sellerB = new MatrixTrader();
        MatrixTrader buyerA = new MatrixTrader();
        MatrixTrader buyerB = new MatrixTrader();

        base.mint(address(sellerA), 2 * ONE);
        base.mint(address(sellerB), 2 * ONE);
        quote.mint(address(buyerA), 1_000_000);
        quote.mint(address(buyerB), 1_000_000);
        sellerA.approve(base, book);
        sellerB.approve(base, book);
        buyerA.approve(quote, book);
        buyerB.approve(quote, book);
        factory.setPairTradingFeeBps(address(base), address(quote), 250);

        bytes32 askA =
            sellerA.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100_000, 1);
        bytes32 askB =
            sellerB.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100_000, 1);
        base.setBalance(address(book), ONE);
        require(
            !buyerA.attemptPlace(
                book, address(base), address(quote), ISpotCLOB.Side.Buy, 100_000, 1
            ),
            "base-insolvent market accepted an order"
        );
        sellerA.cancel(book, askA);
        sellerB.cancel(book, askB);
        require(base.balanceOf(address(sellerA)) == 3 * ONE / 2, "wrong first base recovery");
        require(base.balanceOf(address(sellerB)) == 3 * ONE / 2, "wrong second base recovery");

        bytes32 bidA =
            buyerA.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 90_000, 1);
        bytes32 bidB =
            buyerB.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 90_000, 1);
        uint256 claim = 90_000 + 2_250;
        require(book.totalEscrowLiability(address(quote)) == 2 * claim, "wrong quote claims");
        quote.setBalance(address(book), claim);
        require(
            !sellerA.attemptPlace(
                book, address(base), address(quote), ISpotCLOB.Side.Sell, 90_000, 1
            ),
            "quote-insolvent market accepted an order"
        );
        buyerA.cancel(book, bidA);
        buyerB.cancel(book, bidB);
        require(
            quote.balanceOf(address(buyerA)) == 1_000_000 - claim / 2, "wrong first quote recovery"
        );
        require(
            quote.balanceOf(address(buyerB)) == 1_000_000 - claim / 2, "wrong second quote recovery"
        );
        require(book.totalEscrowLiability(address(quote)) == 0, "quote claims remained");

        _assertRebasedMarketResumes(base, quote, book, sellerA, buyerA);
    }

    function _deploy()
        private
        returns (MatrixToken base, MatrixToken quote, SpotCLOB book, SpotCLOBFactory factory)
    {
        base = new MatrixToken();
        quote = new MatrixToken();
        factory = new SpotCLOBFactory();
        factory.setQuoteToken(address(quote), true);
        factory.setPairLotDecimals(address(base), address(quote), 0);
        (, address deployed) = factory.createPair(address(base), address(quote), 1, 1, 120_000);
        book = SpotCLOB(deployed);
    }

    function _assertRebasedMarketResumes(
        MatrixToken base,
        MatrixToken quote,
        SpotCLOB book,
        MatrixTrader seller,
        MatrixTrader buyer
    ) private {
        bytes32 ask = seller.place(
            book, address(base), address(quote), ISpotCLOB.Side.Sell, 100_000, 1
        );
        bytes32 taker =
            buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100_000, 1);
        _assertOrder(book, ask, 1, 1, ISpotCLOB.OrderStatus.Filled);
        _assertOrder(book, taker, 1, 1, ISpotCLOB.OrderStatus.Filled);
        require(book.accruedTradingFees(address(quote)) == 5_000, "resumed fees incorrect");
        require(quote.balanceOf(address(book)) == 5_000, "resumed fees are not backed");
    }

    function _assertOrder(
        SpotCLOB book,
        bytes32 id,
        uint128 expectedQuantity,
        uint128 expectedFilled,
        ISpotCLOB.OrderStatus expectedStatus
    ) private view {
        (, ISpotCLOB.OrderState memory state) = book.getOrder(id);
        require(state.quantity == expectedQuantity, "wrong accepted quantity");
        require(state.filledQuantity == expectedFilled, "wrong filled quantity");
        require(state.status == expectedStatus, "wrong order status");
    }
}
