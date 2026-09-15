// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolRegistry } from "../src/IPoolRegistry.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";

contract FactoryActor {
    function setMarketCreationFee(SpotCLOBFactory factory, uint256 newFee) external {
        factory.setMarketCreationFee(newFee);
    }

    function withdrawMarketCreationFees(
        SpotCLOBFactory factory,
        address payable recipient,
        uint256 amount
    ) external {
        factory.withdrawMarketCreationFees(recipient, amount);
    }

    function setQuoteToken(SpotCLOBFactory factory, address token, bool allowed) external {
        factory.setQuoteToken(token, allowed);
    }

    function setDefaultLotDecimals(SpotCLOBFactory factory, uint8 lotDecimals) external {
        factory.setDefaultLotDecimals(lotDecimals);
    }

    function setDefaultTradingFeeBps(SpotCLOBFactory factory, uint16 tradingFeeBps) external {
        factory.setDefaultTradingFeeBps(tradingFeeBps);
    }

    function setPairTradingFeeBps(
        SpotCLOBFactory factory,
        address baseAsset,
        address quoteAsset,
        uint16 tradingFeeBps
    ) external {
        factory.setPairTradingFeeBps(baseAsset, quoteAsset, tradingFeeBps);
    }

    function setPairLotDecimals(
        SpotCLOBFactory factory,
        address baseAsset,
        address quoteAsset,
        uint8 lotDecimals
    ) external {
        factory.setPairLotDecimals(baseAsset, quoteAsset, lotDecimals);
    }

    function clearPairLotDecimals(SpotCLOBFactory factory, address baseAsset, address quoteAsset)
        external
    {
        factory.clearPairLotDecimals(baseAsset, quoteAsset);
    }

    function createPair(
        SpotCLOBFactory factory,
        address baseAsset,
        address quoteAsset,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) external payable returns (bytes32 id, address book) {
        return factory.createPair{ value: msg.value }(
            baseAsset, quoteAsset, tickSize, minTick, maxTick
        );
    }

    function createPairWithLotSize(
        SpotCLOBFactory factory,
        address baseAsset,
        address quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) external payable returns (bytes32 id, address book) {
        return factory.createPair{ value: msg.value }(
            baseAsset, quoteAsset, lotSize, tickSize, minTick, maxTick
        );
    }

    function createPairWithFee(
        SpotCLOBFactory factory,
        address baseAsset,
        address quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick,
        uint16 tradingFeeBps
    ) external payable returns (bytes32 id, address book) {
        return factory.createPairWithFee{ value: msg.value }(
            baseAsset, quoteAsset, lotSize, tickSize, minTick, maxTick, tradingFeeBps
        );
    }
}

contract PoolRegistryTest {
    uint128 private constant LOT_SIZE = 1e10;
    uint128 private constant TICK_SIZE = 10;
    uint24 private constant MIN_TICK = 1;
    uint24 private constant MAX_TICK = 100_000;

    SpotCLOBFactory private factory;
    FactoryActor private nonOwner;
    address private baseA;
    address private baseB;
    address private usdc;
    address private usdt;

    function setUp() public {
        factory = new SpotCLOBFactory();
        nonOwner = new FactoryActor();
        baseA = address(new MockERC20("Base A", "BASEA", 18));
        baseB = address(new MockERC20("Base B", "BASEB", 18));
        usdc = address(new MockERC20("USD Coin", "USDC", 6));
        usdt = address(new MockERC20("Tether", "USDT", 6));
    }

    function testOwnerCanAddAndRemoveQuoteTokens() public {
        factory.setQuoteToken(usdc, true);
        factory.setQuoteToken(usdt, true);
        require(factory.isQuoteToken(usdc), "USDC was not allowed");
        require(factory.isQuoteToken(usdt), "USDT was not allowed");

        factory.setQuoteToken(usdc, false);
        require(!factory.isQuoteToken(usdc), "USDC was not removed");
        require(factory.isQuoteToken(usdt), "USDT was unexpectedly removed");
    }

    function testOnlyOwnerCanUpdateQuoteTokens() public {
        require(!_callSetQuoteToken(usdc, true), "non-owner quote update succeeded");
        require(!factory.isQuoteToken(usdc), "non-owner changed quote allowlist");
    }

    function testDefaultLotPrecisionIsEightDecimals() public view {
        require(factory.defaultLotDecimals() == 8, "wrong default lot decimals");
        require(factory.pairLotDecimals(baseA, usdc) == 8, "wrong effective lot decimals");
        require(factory.pairLotSize(baseA, usdc) == LOT_SIZE, "wrong derived lot size");
        require(factory.pairLotDecimals(usdc, baseA) == 6, "token precision was not capped");
        require(factory.pairLotSize(usdc, baseA) == 1, "small-decimal token lot is not one atom");
    }

    function testOwnerCanConfigureDefaultAndPairLotPrecision() public {
        factory.setDefaultLotDecimals(6);
        require(factory.pairLotSize(baseA, usdc) == 1e12, "default precision was not applied");

        factory.setPairLotDecimals(baseA, usdc, 0);
        require(factory.pairLotSize(baseA, usdc) == 1e18, "zero-decimal override was not applied");

        factory.setPairLotDecimals(baseA, usdc, 7);
        require(factory.pairLotDecimals(baseA, usdc) == 7, "pair precision was not stored");
        require(factory.pairLotSize(baseA, usdc) == 1e11, "pair lot size was not derived");

        factory.clearPairLotDecimals(baseA, usdc);
        require(factory.pairLotDecimals(baseA, usdc) == 6, "pair did not return to default");
    }

    function testOnlyOwnerCanConfigureLotPrecision() public {
        require(!_callSetDefaultLotDecimals(7), "non-owner changed default precision");
        require(!_callSetPairLotDecimals(baseA, usdc, 7), "non-owner changed pair precision");
        require(factory.defaultLotDecimals() == 8, "default precision changed");
        require(factory.pairLotDecimals(baseA, usdc) == 8, "pair precision changed");
    }

    function testPermissionlessCreationDeploysAndIndexesPair() public {
        factory.setQuoteToken(usdc, true);
        bytes32 expectedId = factory.pairId(baseA, usdc);
        address predicted = factory.predictPairAddress(baseA, usdc);

        (bytes32 createdId, address book) =
            nonOwner.createPair(factory, baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK);
        require(createdId == expectedId, "wrong pair id");
        require(book == predicted, "CREATE2 address was not deterministic");
        require(factory.getPair(createdId) == book, "id lookup returned wrong book");
        require(factory.getPair(baseA, usdc) == book, "asset lookup returned wrong book");

        IPoolRegistry.Pool memory pool = factory.getPool(createdId);
        require(pool.baseAsset == baseA && pool.quoteAsset == usdc, "wrong pair assets");
        require(pool.book == book && pool.exists, "pair was not fully registered");
        require(pool.lotSize == LOT_SIZE && pool.tickSize == TICK_SIZE, "wrong sizing");
        require(pool.minTick == MIN_TICK && pool.maxTick == MAX_TICK, "wrong range");
        require(pool.tradingFeeBps == 10, "wrong default trading fee");

        SpotCLOB.Market memory market = SpotCLOB(book).getMarket(baseA, usdc);
        require(market.enabled, "deployed book was not activated");
        require(
            market.baseAsset == baseA && market.quoteAsset == usdc, "book activated the wrong pair"
        );
        require(market.tradingFeeBps == 10, "book cached the wrong fee");
    }

    function testCreatorCanConfigureFeeAndAdminCanChangeIt() public {
        factory.setQuoteToken(usdc, true);
        (bytes32 id, address book) = nonOwner.createPairWithFee(
            factory, baseA, usdc, uint128(1 ether), 1, 1, type(uint24).max, 30
        );

        require(factory.getPool(id).tradingFeeBps == 30, "creation fee was not stored");
        require(
            SpotCLOB(book).getMarket(baseA, usdc).tradingFeeBps == 30,
            "creation fee was not activated"
        );
        require(!_callSetPairTradingFeeBps(baseA, usdc, 25), "non-owner changed the pair fee");

        factory.setPairTradingFeeBps(baseA, usdc, 25);
        require(factory.getPool(id).tradingFeeBps == 25, "admin fee was not stored");
        require(
            SpotCLOB(book).getMarket(baseA, usdc).tradingFeeBps == 25,
            "admin fee was not synchronized"
        );
    }

    function testFeeConfigurationIsCappedAtTenPercent() public {
        require(factory.MAX_TRADING_FEE_BPS() == 1_000, "wrong fee cap");
        require(!_callSetDefaultTradingFeeBps(1_001), "excessive default fee succeeded");
        factory.setDefaultTradingFeeBps(100);
        require(factory.defaultTradingFeeBps() == 100, "default fee was not changed");
    }

    function testNativeMarketCreationFeeDefaultsToZero() public view {
        require(factory.marketCreationFee() == 0, "creation fee did not default to zero");
    }

    function testOwnerConfiguresNativeMarketCreationFeeAndEveryCreationPathPaysIt() public {
        uint256 creationFee = 3 wei;
        address baseC = address(new MockERC20("Base C", "BASEC", 18));
        factory.setQuoteToken(usdc, true);

        require(!_callSetMarketCreationFee(creationFee), "non-owner changed creation fee");
        factory.setMarketCreationFee(creationFee);
        require(factory.marketCreationFee() == creationFee, "creation fee was not stored");

        nonOwner.createPair{ value: creationFee }(
            factory, baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK
        );
        nonOwner.createPairWithLotSize{ value: creationFee }(
            factory, baseB, usdc, LOT_SIZE, TICK_SIZE, MIN_TICK, MAX_TICK
        );
        nonOwner.createPairWithFee{ value: creationFee }(
            factory, baseC, usdc, LOT_SIZE, TICK_SIZE, MIN_TICK, MAX_TICK, 25
        );

        require(address(factory).balance == creationFee * 3, "native fees were not collected");
    }

    function testMarketCreationRequiresExactNativeFeeAndOwnerCanWithdraw() public {
        uint256 creationFee = 0.25 ether;
        address payable recipient = payable(address(0xBEEF));
        factory.setQuoteToken(usdc, true);
        factory.setMarketCreationFee(creationFee);

        require(!_callCreatePairWithValue(creationFee - 1), "underpaid market creation succeeded");
        require(!_callCreatePairWithValue(creationFee + 1), "overpaid market creation succeeded");

        nonOwner.createPair{ value: creationFee }(
            factory, baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK
        );
        require(address(factory).balance == creationFee, "exact creation fee was not retained");
        require(
            !_callWithdrawMarketCreationFees(recipient, creationFee),
            "non-owner withdrew creation fees"
        );

        uint256 recipientBefore = recipient.balance;
        factory.withdrawMarketCreationFees(recipient, creationFee);
        require(
            recipient.balance == recipientBefore + creationFee, "withdrawal recipient was unpaid"
        );
        require(address(factory).balance == 0, "withdrawn native fee remained in factory");
    }

    function testPermissionlessCreationAcceptsExplicitMultiTokenLotSize() public {
        uint128 multiTokenLotSize = 100_000e18;
        factory.setQuoteToken(usdc, true);

        (bytes32 id,) = nonOwner.createPairWithLotSize(
            factory, baseA, usdc, multiTokenLotSize, 1, 1, type(uint24).max
        );

        IPoolRegistry.Pool memory pool = factory.getPool(id);
        require(pool.lotSize == multiTokenLotSize, "explicit multi-token lot changed");
        require(pool.tickSize == 1, "explicit market tick changed");
        require(factory.pairLotSize(baseA, usdc) == multiTokenLotSize, "lot lookup changed");
    }

    function testRejectsZeroExplicitLotSize() public {
        factory.setQuoteToken(usdc, true);
        (bool success,) = address(nonOwner)
            .call(
                abi.encodeCall(
                    FactoryActor.createPairWithLotSize,
                    (factory, baseA, usdc, uint128(0), TICK_SIZE, MIN_TICK, MAX_TICK)
                )
            );
        require(!success, "zero explicit lot size succeeded");
    }

    function testPairLotPrecisionCannotChangeAfterCreation() public {
        factory.setQuoteToken(usdc, true);
        factory.createPair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK);
        factory.setDefaultLotDecimals(6);
        (bool changed,) = address(factory)
            .call(abi.encodeCall(SpotCLOBFactory.setPairLotDecimals, (baseA, usdc, uint8(7))));
        require(!changed, "created pair precision was changed");
        require(factory.pairLotDecimals(baseA, usdc) == 8, "created precision followed default");
        require(factory.pairLotSize(baseA, usdc) == LOT_SIZE, "derived lot size changed");
        require(factory.getPool(baseA, usdc).lotSize == LOT_SIZE, "created lot size changed");

        (bool cleared,) = address(factory)
            .call(abi.encodeCall(SpotCLOBFactory.clearPairLotDecimals, (baseA, usdc)));
        require(!cleared, "created pair precision was cleared");
    }

    function testRejectsPairPrecisionBeyondTokenDecimals() public {
        (bool success,) = address(factory)
            .call(abi.encodeCall(SpotCLOBFactory.setPairLotDecimals, (baseA, usdc, 19)));
        require(!success, "unsupported pair precision was accepted");
    }

    function testRejectsLotSizeExponentBeyondUint128() public {
        address highDecimals = address(new MockERC20("High Decimals", "HIGH", 50));
        (bool overrideSuccess,) = address(factory)
            .call(
                abi.encodeCall(SpotCLOBFactory.setPairLotDecimals, (highDecimals, usdc, uint8(10)))
            );
        require(!overrideSuccess, "overflowing override succeeded");

        (bool derivedSuccess,) = address(factory)
            .staticcall(abi.encodeCall(SpotCLOBFactory.pairLotSize, (highDecimals, usdc)));
        require(!derivedSuccess, "overflowing derived lot succeeded");
    }

    function testBaseQuoteOrderIsSignificant() public {
        factory.setQuoteToken(baseA, true);
        factory.setQuoteToken(usdc, true);

        (bytes32 forward,) = factory.createPair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK);
        (bytes32 reverse,) = factory.createPair(usdc, baseA, TICK_SIZE, MIN_TICK, MAX_TICK);

        require(forward != reverse, "reversed market shared an id");
        require(factory.getPool(forward).quoteAsset == usdc, "forward quote changed");
        require(factory.getPool(reverse).quoteAsset == baseA, "reverse quote changed");
    }

    function testRejectsDuplicatePair() public {
        factory.setQuoteToken(usdc, true);
        factory.createPair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK);
        require(
            !_callCreatePair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK), "duplicate pair succeeded"
        );

        (bool explicitSuccess,) = address(nonOwner)
            .call(
                abi.encodeCall(
                    FactoryActor.createPairWithLotSize,
                    (factory, baseA, usdc, LOT_SIZE, TICK_SIZE, MIN_TICK, MAX_TICK)
                )
            );
        require(!explicitSuccess, "duplicate explicit-lot pair succeeded");
    }

    function testRejectsInvalidPairAndParameters() public {
        factory.setQuoteToken(usdc, true);
        require(
            !_callCreatePair(usdc, usdc, TICK_SIZE, MIN_TICK, MAX_TICK), "same-token pair succeeded"
        );
        require(
            !_callCreatePair(address(0), usdc, TICK_SIZE, MIN_TICK, MAX_TICK), "zero base succeeded"
        );
        require(!_callCreatePair(baseA, usdc, 0, MIN_TICK, MAX_TICK), "zero tick size succeeded");
        require(
            !_callCreatePair(baseA, usdc, TICK_SIZE, 0, MAX_TICK), "zero minimum tick succeeded"
        );
        require(!_callCreatePair(baseA, usdc, TICK_SIZE, 101, 100), "inverted tick range succeeded");

        (bool zeroBaseOverride,) = address(factory)
            .call(abi.encodeCall(SpotCLOBFactory.setPairLotDecimals, (address(0), usdc, uint8(0))));
        require(!zeroBaseOverride, "zero base override succeeded");
        (bool sameTokenOverride,) = address(factory)
            .call(abi.encodeCall(SpotCLOBFactory.setPairLotDecimals, (baseA, baseA, uint8(0))));
        require(!sameTokenOverride, "same-token override succeeded");
        (bool zeroQuote,) =
            address(factory).call(abi.encodeCall(SpotCLOBFactory.setQuoteToken, (address(0), true)));
        require(!zeroQuote, "zero quote token allowed");
    }

    function testRejectsUnapprovedQuoteToken() public {
        require(
            !_callCreatePair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK),
            "unapproved quote succeeded"
        );
    }

    function testRemovingQuoteOnlyBlocksFuturePairs() public {
        factory.setQuoteToken(usdc, true);
        (bytes32 existingId, address existingBook) =
            factory.createPair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK);
        factory.setQuoteToken(usdc, false);

        require(factory.getPair(existingId) == existingBook, "existing pair was disabled");
        require(
            !_callCreatePair(baseB, usdc, TICK_SIZE, MIN_TICK, MAX_TICK),
            "removed quote created a new pair"
        );
    }

    function testEnumeratesMultiplePairs() public {
        factory.setQuoteToken(usdc, true);
        factory.setQuoteToken(usdt, true);
        (bytes32 first,) = factory.createPair(baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK);
        (bytes32 second,) = factory.createPair(baseB, usdt, TICK_SIZE, MIN_TICK, MAX_TICK);

        require(factory.allPairsLength() == 2, "wrong pair count");
        require(factory.pairAt(0) == first, "wrong first pair");
        require(factory.pairAt(1) == second, "wrong second pair");

        (bool outOfBounds,) =
            address(factory).staticcall(abi.encodeCall(SpotCLOBFactory.pairAt, (uint256(2))));
        require(!outOfBounds, "out-of-bounds pair read succeeded");
    }

    function testRejectsTickRangeWhosePriceDoesNotFitUint128() public {
        factory.setQuoteToken(usdc, true);
        require(
            !_callCreatePair(baseA, usdc, type(uint128).max, MIN_TICK, type(uint24).max),
            "overflowing price range succeeded"
        );
    }

    function _callSetQuoteToken(address token, bool allowed) private returns (bool success) {
        (success,) = address(nonOwner)
            .call(abi.encodeCall(FactoryActor.setQuoteToken, (factory, token, allowed)));
    }

    function _callSetDefaultLotDecimals(uint8 lotDecimals) private returns (bool success) {
        (success,) = address(nonOwner)
            .call(abi.encodeCall(FactoryActor.setDefaultLotDecimals, (factory, lotDecimals)));
    }

    function _callSetDefaultTradingFeeBps(uint16 tradingFeeBps) private returns (bool success) {
        (success,) = address(nonOwner)
            .call(abi.encodeCall(FactoryActor.setDefaultTradingFeeBps, (factory, tradingFeeBps)));
    }

    function _callSetMarketCreationFee(uint256 newFee) private returns (bool success) {
        (success,) = address(nonOwner)
            .call(abi.encodeCall(FactoryActor.setMarketCreationFee, (factory, newFee)));
    }

    function _callWithdrawMarketCreationFees(address payable recipient, uint256 amount)
        private
        returns (bool success)
    {
        (success,) = address(nonOwner)
            .call(
                abi.encodeCall(
                    FactoryActor.withdrawMarketCreationFees, (factory, recipient, amount)
                )
            );
    }

    function _callSetPairTradingFeeBps(address baseAsset, address quoteAsset, uint16 tradingFeeBps)
        private
        returns (bool success)
    {
        (success,) = address(nonOwner)
            .call(
                abi.encodeCall(
                    FactoryActor.setPairTradingFeeBps,
                    (factory, baseAsset, quoteAsset, tradingFeeBps)
                )
            );
    }

    function _callSetPairLotDecimals(address baseAsset, address quoteAsset, uint8 lotDecimals)
        private
        returns (bool success)
    {
        (success,) = address(nonOwner)
            .call(
                abi.encodeCall(
                    FactoryActor.setPairLotDecimals, (factory, baseAsset, quoteAsset, lotDecimals)
                )
            );
    }

    function _callCreatePair(
        address baseAsset,
        address quoteAsset,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) private returns (bool success) {
        (success,) = address(nonOwner)
            .call(
                abi.encodeCall(
                    FactoryActor.createPair,
                    (factory, baseAsset, quoteAsset, tickSize, minTick, maxTick)
                )
            );
    }

    function _callCreatePairWithValue(uint256 value) private returns (bool success) {
        (success,) = address(nonOwner).call{ value: value }(
            abi.encodeCall(
                FactoryActor.createPair, (factory, baseA, usdc, TICK_SIZE, MIN_TICK, MAX_TICK)
            )
        );
    }
}
