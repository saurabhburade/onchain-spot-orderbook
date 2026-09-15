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
        balanceOf[to] += mode == FEE_TRANSFER ? amount - 1 : amount;
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
        balanceOf[to] += mode == FEE_TRANSFER_FROM ? amount - 1 : amount;
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
                expiry: 0,
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

    function testRejectsFeeOnTransferFrom() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader buyer = new AdversarialTrader();
        quote.mint(address(buyer), 1_000);
        buyer.approve(quote, book);
        quote.setMode(quote.FEE_TRANSFER_FROM());

        require(
            !buyer.attemptPlace(book, address(base), address(quote), ISpotCLOB.Side.Buy, 100, 1),
            "fee-on-transferFrom token accepted"
        );
    }

    function testRejectsFeeOnOutgoingTransfer() public {
        (SpotCLOB book, AdversarialToken base, AdversarialToken quote) = _deployBook();
        AdversarialTrader seller = new AdversarialTrader();
        base.mint(address(seller), 2 ether);
        seller.approve(base, book);
        bytes32 orderId =
            seller.place(book, address(base), address(quote), ISpotCLOB.Side.Sell, 100, 1);

        base.setMode(base.FEE_TRANSFER());
        require(!seller.attemptCancel(book, orderId), "fee-on-transfer token accepted");
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
            factory.createPair(address(base), address(quote), uint128(1 ether), 1, 1, 1_000);
        book = SpotCLOB(deployed);
    }
}
