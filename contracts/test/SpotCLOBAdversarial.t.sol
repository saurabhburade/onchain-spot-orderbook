// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

interface StorageVm {
    function load(address target, bytes32 slot) external view returns (bytes32);
    function store(address target, bytes32 slot, bytes32 value) external;
}

contract AdversarialToken {
    uint8 public constant NORMAL = 0;
    uint8 public constant FALSE_TRANSFER = 1;
    uint8 public constant FEE_TRANSFER_FROM = 2;
    uint8 public constant FEE_TRANSFER = 3;
    uint8 public constant REENTER_TRANSFER_FROM = 4;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public mode;
    uint256 public transferFee = 1;
    SpotCLOB public reentryTarget;
    bool public reentryBlocked;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    function setTransferFee(uint256 transferFee_) external {
        transferFee = transferFee_;
    }

    function setReentryTarget(SpotCLOB target) external {
        reentryTarget = target;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (mode == FALSE_TRANSFER) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += mode == FEE_TRANSFER ? amount - transferFee : amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == REENTER_TRANSFER_FROM) {
            (bool success,) = address(reentryTarget)
                .call(abi.encodeCall(SpotCLOB.cancelOrder, (bytes32(uint256(1)))));
            reentryBlocked = !success;
        }
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += mode == FEE_TRANSFER_FROM ? amount - transferFee : amount;
        return true;
    }
}

contract AdversarialTrader {
    function approve(AdversarialToken token, SpotCLOB book) external {
        token.approve(address(book), type(uint256).max);
    }

    function place(
        SpotCLOB book,
        address base,
        address quote,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity
    ) external returns (bytes32) {
        return book.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: address(this),
                baseAsset: base,
                quoteAsset: quote,
                side: side,
                price: price,
                quantity: quantity,
                clientOrderId: 0
            })
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
        (success,) = address(this)
            .call(
                abi.encodeCall(AdversarialTrader.place, (book, base, quote, side, price, quantity))
            );
    }

    function attemptCancel(SpotCLOB book, bytes32 orderId) external returns (bool success) {
        (success,) = address(book).call(abi.encodeCall(SpotCLOB.cancelOrder, (orderId)));
    }

    function attemptMarketBuy(
        SpotCLOB book,
        address base,
        address quote,
        uint128 quantity,
        uint256 minReceive
    ) external returns (bool success) {
        ISpotCLOB.MarketOrder memory order = ISpotCLOB.MarketOrder({
            trader: address(this),
            baseAsset: base,
            quoteAsset: quote,
            side: ISpotCLOB.Side.Buy,
            quantity: quantity,
            priceLimit: 100,
            minFillQuantity: quantity,
            minReceive: minReceive,
            clientOrderId: 0
        });
        (success,) =
            address(book).call(abi.encodeCall(SpotCLOB.executeMarketOrder, (order, uint32(64))));
    }
}

contract SpotCLOBAdversarialTest {
    address private constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    StorageVm private constant vm = StorageVm(VM_ADDRESS);

    function testRejectsFalseReturnOnOutgoingTransfer() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        base.mint(address(seller), 2 ether);
        seller.approve(base, book);
        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);

        base.setMode(base.FALSE_TRANSFER());
        require(!seller.attemptCancel(book, orderId), "false-return transfer accepted");
    }

    function testStandardEntryPointUsesFeeOnTransferBalanceDelta() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        base.mint(address(seller), 100);
        seller.approve(base, book);
        base.setMode(base.FEE_TRANSFER_FROM());

        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 100);
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(orderId);
        require(order.quantity == 99 && state.quantity == 99, "order ignored received amount");
        (, uint256 locked,) = book.balanceOf(address(seller), address(base));
        require(locked == 99 && base.balanceOf(address(book)) == 99, "wrong funded escrow");
    }

    function testFeeOnTransferFundingUsesReceivedQuantityAndNetPayout() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        AdversarialTrader buyer = new AdversarialTrader();
        base.mint(address(seller), 100);
        quote.mint(address(buyer), 20_000);
        seller.approve(base, book);
        buyer.approve(quote, book);
        base.setMode(base.FEE_TRANSFER_FROM());

        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 100);
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(orderId);
        require(order.quantity == 99 && state.quantity == 99, "order ignored received amount");
        (, uint256 locked,) = book.balanceOf(address(seller), address(base));
        require(locked == 99 && base.balanceOf(address(book)) == 99, "wrong funded escrow");

        base.setMode(base.FEE_TRANSFER());
        bytes32 buyerOrder =
            buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 99);
        (, state) = book.getOrder(orderId);
        require(state.status == ISpotCLOB.OrderStatus.Filled, "taxed maker did not fill");
        (, state) = book.getOrder(buyerOrder);
        require(state.status == ISpotCLOB.OrderStatus.Filled, "buyer did not fill");
        require(base.balanceOf(address(buyer)) == 98, "net payout was not measured");
        require(base.balanceOf(address(book)) == 0, "base escrow remained after fill");
    }

    function testFeeOnTransferMarketMinimumUsesNetPayout() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        AdversarialTrader buyer = new AdversarialTrader();
        base.mint(address(seller), 2);
        quote.mint(address(buyer), 1_000);
        seller.approve(base, book);
        buyer.approve(quote, book);
        bytes32 ask = seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 2);
        base.setMode(base.FEE_TRANSFER());

        require(
            !buyer.attemptMarketBuy(book, address(base), address(quote), 2, 2),
            "gross output incorrectly satisfied minimum"
        );
        (, ISpotCLOB.OrderState memory state) = book.getOrder(ask);
        require(state.status == ISpotCLOB.OrderStatus.Open, "failed minimum changed maker");
        require(base.balanceOf(address(book)) == 2, "failed minimum changed escrow");

        require(
            buyer.attemptMarketBuy(book, address(base), address(quote), 2, 1),
            "net output did not satisfy minimum"
        );
        require(base.balanceOf(address(buyer)) == 1, "wrong net market payout");
        require(base.balanceOf(address(book)) == 0, "market fill retained base escrow");
    }

    function testFeeOnTransferFundingRejectsZeroReceivedQuantity() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        base.mint(address(seller), 100);
        seller.approve(base, book);
        base.setTransferFee(100);
        base.setMode(base.FEE_TRANSFER_FROM());

        require(
            !seller.attemptPlace(
                book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 100
            ),
            "zero-funded order accepted"
        );
        require(base.balanceOf(address(seller)) == 100, "failed placement changed balance");
        require(base.balanceOf(address(book)) == 0, "failed placement retained escrow");
    }

    function testFeeOnTransferQuoteFundingUsesMaximumAffordableBuyQuantity() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader buyer = new AdversarialTrader();
        quote.mint(address(buyer), 10_010);
        buyer.approve(quote, book);
        quote.setMode(quote.FEE_TRANSFER_FROM());

        bytes32 orderId =
            buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 100);
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(orderId);
        require(order.quantity == 99 && state.quantity == 99, "wrong affordable buy quantity");
        (, uint256 locked,) = book.balanceOf(address(buyer), address(quote));
        require(locked == 9_909, "wrong quote and fee reserve");
        require(quote.balanceOf(address(book)) == 9_909, "book retained surplus quote");
        require(quote.balanceOf(address(buyer)) == 100, "surplus quote was not refunded");
    }

    function testFuzz_FeeOnTransferSellFundingMatchesBalanceDelta(uint8 rawFee) public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        uint128 fee = uint128(1 + uint256(rawFee) % 99);
        uint128 acceptedQuantity = 100 - fee;
        base.mint(address(seller), 100);
        seller.approve(base, book);
        base.setTransferFee(fee);
        base.setMode(base.FEE_TRANSFER_FROM());

        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 100);
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(orderId);
        require(
            order.quantity == acceptedQuantity && state.quantity == acceptedQuantity,
            "stored quantity differs from received balance delta"
        );
        (, uint256 locked,) = book.balanceOf(address(seller), address(base));
        require(locked == acceptedQuantity, "locked escrow differs from accepted quantity");
        require(
            base.balanceOf(address(book)) == acceptedQuantity, "book is not fully collateralized"
        );
    }

    function testNormalTokenFundingPreservesRequestedQuantity() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        base.mint(address(seller), 100);
        seller.approve(base, book);

        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 100);
        (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
            book.getOrder(orderId);
        require(order.quantity == 100 && state.quantity == 100, "normal quantity changed");
        (, uint256 locked,) = book.balanceOf(address(seller), address(base));
        require(locked == 100 && base.balanceOf(address(book)) == 100, "wrong normal escrow");
    }

    function testFeeOnOutgoingTransferCancellationUsesGrossEscrow() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        base.mint(address(seller), 2);
        seller.approve(base, book);
        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 2);

        base.setMode(base.FEE_TRANSFER());
        require(seller.attemptCancel(book, orderId), "fee-on-transfer cancellation rejected");
        require(base.balanceOf(address(book)) == 0, "cancel retained gross escrow");
        (, ISpotCLOB.OrderState memory state) = book.getOrder(orderId);
        require(state.status == ISpotCLOB.OrderStatus.Cancelled, "order was not cancelled");
    }

    function testBlocksTokenCallbackReentrancy() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader buyer = new AdversarialTrader();
        quote.mint(address(buyer), 1_000);
        buyer.approve(quote, book);
        quote.setReentryTarget(book);
        quote.setMode(quote.REENTER_TRANSFER_FROM());

        buyer.place(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1);
        require(quote.reentryBlocked(), "token callback reentered the book");
    }

    function testRejectsAssetIfActivationSupportInvariantIsCorrupted() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader buyer = new AdversarialTrader();
        quote.mint(address(buyer), 1_000);
        buyer.approve(quote, book);

        // `_supportedAssets` is storage slot 5. This corruption test proves the runtime guard while
        // normal users remain unable to mutate another contract's private storage.
        bytes32 quoteSupportSlot = keccak256(abi.encode(address(quote), uint256(5)));
        require(vm.load(address(book), quoteSupportSlot) == bytes32(uint256(1)), "wrong slot");
        vm.store(address(book), quoteSupportSlot, bytes32(0));
        require(
            !buyer.attemptPlace(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1),
            "unsupported asset accepted"
        );
    }

    function _deployBook()
        private
        returns (SpotCLOB book, AdversarialToken base, AdversarialToken quote)
    {
        SpotCLOBFactory factory = new SpotCLOBFactory();
        base = new AdversarialToken();
        quote = new AdversarialToken();
        factory.setQuoteToken(address(quote), true);
        (, address deployed) =
            factory.createPair(address(base), address(quote), uint128(1), 1, 1, 1_000);
        book = SpotCLOB(deployed);
    }
}
