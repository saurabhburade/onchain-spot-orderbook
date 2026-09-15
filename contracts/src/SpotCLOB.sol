// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolRegistry } from "./IPoolRegistry.sol";
import { ISpotCLOB } from "./ISpotCLOB.sol";
import { ISpotCLOBFactory } from "./ISpotCLOBFactory.sol";
import { PriceBitmap } from "./libraries/PriceBitmap.sol";
import { PriceTree } from "./libraries/PriceTree.sol";
import { SpotPriceMath } from "./libraries/SpotPriceMath.sol";

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Fully on-chain, price-time-priority spot order book with per-order ERC-20 escrow.
/// @dev Legacy pools use quote atoms/base lots. Agnostic pools use priceX18/raw base atoms.
contract SpotCLOB is ISpotCLOB {
    using PriceBitmap for PriceBitmap.Data;
    using PriceTree for PriceTree.Data;

    uint32 public constant DEFAULT_MAX_BOOK_STEPS = 64;
    uint16 public constant MAX_VIEW_DEPTH = 256;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint8 public constant USER_ORDER_FLAG_OPEN = 1 << 0;
    uint8 public constant USER_ORDER_FLAG_FILLED = 1 << 1;
    uint8 public constant USER_ORDER_FLAG_CANCELED = 1 << 2;
    uint8 private constant _USER_ORDER_FLAGS_ALL =
        USER_ORDER_FLAG_OPEN | USER_ORDER_FLAG_FILLED | USER_ORDER_FLAG_CANCELED;

    error Unauthorized();
    error ReentrantCall();
    error InvalidMarket();
    error MarketAlreadyActive();
    error UnsupportedAsset();
    error InvalidOrder();
    error InvalidTick();
    error InvalidLotQuantity();
    error OrderNotOpen();
    error MatchLimitExceeded();
    error NoLiquidity();
    error MinimumFillNotMet();
    error ViewDepthTooLarge();
    error InvalidPageSize();
    error InvalidOrderFlags();
    error TokenTransferFailed();
    error UnsupportedTokenBehavior();
    error InvalidFeeWithdrawal();
    error InsufficientAccruedFees();
    error AlreadyInitialized();

    struct Market {
        address baseAsset;
        address quoteAsset;
        uint128 lotSize;
        uint128 tickSize;
        uint24 minTick;
        uint24 maxTick;
        uint16 tradingFeeBps;
        uint8 baseDecimals;
        uint8 quoteDecimals;
        bool agnosticPricing;
        bool enabled;
    }

    struct Balance {
        uint256 locked;
    }

    struct PriceLevel {
        uint64 headOrderId;
        uint64 tailOrderId;
        uint128 totalQuantity;
    }

    struct SideBook {
        PriceBitmap.Data legacyTicks;
        PriceTree.Data widePrices;
        mapping(uint128 priceKey => PriceLevel level) levels;
    }

    struct MarketBook {
        SideBook bids;
        SideBook asks;
    }

    struct StoredOrder {
        bytes32 marketId;
        address trader;
        uint128 price;
        uint128 quantity;
        uint128 remaining;
        uint64 expiry;
        uint64 clientOrderId;
        uint64 createdAt;
        uint64 previousOrderId;
        uint64 nextOrderId;
        uint64 nextUserOrderId;
        Side side;
        OrderStatus status;
        bool resting;
        uint256 feeReserve;
        uint256 escrowRemaining;
    }

    event MarketActivated(
        bytes32 indexed marketId,
        address indexed baseAsset,
        address indexed quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick,
        uint16 tradingFeeBps
    );
    event OrderEscrowed(address indexed trader, address indexed asset, uint256 amount);
    event OrderEscrowReleased(address indexed trader, address indexed asset, uint256 amount);
    IPoolRegistry public poolRegistry;
    address public activationAuthority;
    address public feeRecipient;
    bool private _initialized;
    uint64 private _nextOrderId = 1;
    uint256 private _entered = 1;

    mapping(bytes32 marketId => Market market) private _markets;
    mapping(address asset => bool supported) private _supportedAssets;
    mapping(bytes32 marketId => MarketBook book) private _books;
    mapping(bytes32 marketId => uint64 sequence) public bookSequence;
    mapping(uint64 orderId => StoredOrder order) private _orders;
    mapping(address trader => mapping(bytes32 marketId => uint64 orderId)) private _userOrderHead;
    mapping(address account => mapping(address asset => Balance balance)) private _balances;
    mapping(address asset => uint256 amount) public override accruedTradingFees;

    modifier nonReentrant() {
        _enter();
        _;
        _entered = 1;
    }

    function _enter() private {
        if (_entered != 1) revert ReentrantCall();
        _entered = 2;
    }

    constructor(IPoolRegistry registry_) {
        if (address(registry_) == address(0)) {
            // The factory deploys one locked implementation whose code is shared by clones.
            _initialized = true;
        } else {
            _initialize(registry_, msg.sender);
        }
    }

    /// @notice Initialize a deterministic minimal-proxy order book.
    /// @dev Called atomically by the factory immediately after clone deployment.
    function initialize(IPoolRegistry registry_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialize(registry_, msg.sender);
    }

    function _initialize(IPoolRegistry registry_, address authority) private {
        if (address(registry_) == address(0)) revert InvalidMarket();
        _initialized = true;
        _nextOrderId = 1;
        _entered = 1;
        poolRegistry = registry_;
        activationAuthority = authority;
        feeRecipient = ISpotCLOBFactory(address(registry_)).owner();
    }

    function marketId(address baseAsset, address quoteAsset) public pure returns (bytes32) {
        return keccak256(abi.encode(baseAsset, quoteAsset));
    }

    /// @notice Cache a registry pool's immutable parameters for gas-efficient matching.
    function activatePool(bytes32 id) external {
        if (msg.sender != activationAuthority) revert Unauthorized();
        if (_markets[id].enabled) revert MarketAlreadyActive();
        IPoolRegistry.Pool memory pool = poolRegistry.getPool(id);
        if (!pool.exists) revert InvalidMarket();
        _markets[id] = Market({
            baseAsset: pool.baseAsset,
            quoteAsset: pool.quoteAsset,
            lotSize: pool.lotSize,
            tickSize: pool.tickSize,
            minTick: pool.minTick,
            maxTick: pool.maxTick,
            tradingFeeBps: pool.tradingFeeBps,
            baseDecimals: pool.baseDecimals,
            quoteDecimals: pool.quoteDecimals,
            agnosticPricing: pool.agnosticPricing,
            enabled: true
        });
        _supportedAssets[pool.baseAsset] = true;
        _supportedAssets[pool.quoteAsset] = true;
        emit MarketActivated(
            id,
            pool.baseAsset,
            pool.quoteAsset,
            pool.lotSize,
            pool.tickSize,
            pool.minTick,
            pool.maxTick,
            pool.tradingFeeBps
        );
    }

    function setTradingFeeBps(bytes32 id, uint16 tradingFeeBps) external override {
        if (msg.sender != activationAuthority) revert Unauthorized();
        Market storage market = _markets[id];
        if (!market.enabled) revert InvalidMarket();
        uint16 previousFeeBps = market.tradingFeeBps;
        market.tradingFeeBps = tradingFeeBps;
        emit TradingFeeUpdated(id, previousFeeBps, tradingFeeBps);
    }

    function getMarket(address baseAsset, address quoteAsset)
        external
        view
        returns (Market memory)
    {
        return _markets[marketId(baseAsset, quoteAsset)];
    }

    /// @notice Return wallet funds available to trade and funds escrowed by open orders.
    /// @dev The exchange never keeps an idle deposit balance; `free` is held by `account`.
    function balanceOf(address account, address asset)
        external
        view
        override
        returns (uint256 free, uint256 locked, uint256 total)
    {
        Balance storage balance = _balances[account][asset];
        free = IERC20Minimal(asset).balanceOf(account);
        locked = balance.locked;
        total = free + locked;
    }

    function placeLimitOrder(LimitOrder calldata order)
        external
        nonReentrant
        returns (bytes32 orderId)
    {
        orderId = _placeLimitOrder(order, DEFAULT_MAX_BOOK_STEPS);
        _emitBookUpdated(_orders[_decodeOrderId(orderId)].marketId);
    }

    /// @notice Place an order while explicitly bounding fills and expired-order cleanup work.
    function placeLimitOrderWithMaxBookSteps(LimitOrder calldata order, uint32 maxBookSteps)
        external
        nonReentrant
        returns (bytes32 orderId)
    {
        orderId = _placeLimitOrder(order, maxBookSteps);
        _emitBookUpdated(_orders[_decodeOrderId(orderId)].marketId);
    }

    function executeMarketOrder(MarketOrder calldata request, uint32 maxBookSteps)
        external
        nonReentrant
        returns (bytes32 orderId, uint128 filledQuantity, uint256 quoteQuantity)
    {
        if (
            request.trader == address(0) || request.quantity == 0
                || request.minFillQuantity > request.quantity
        ) revert InvalidOrder();
        if (msg.sender != request.trader) revert Unauthorized();

        bytes32 id = marketId(request.baseAsset, request.quoteAsset);
        Market storage market = _markets[id];
        if (
            !market.enabled || request.baseAsset != market.baseAsset
                || request.quoteAsset != market.quoteAsset
        ) revert InvalidMarket();

        uint128 effectiveLimit = request.priceLimit;
        if (effectiveLimit == 0) {
            if (market.agnosticPricing) {
                effectiveLimit = request.side == Side.Buy ? type(uint128).max : 1;
            } else {
                uint24 boundary = request.side == Side.Buy ? market.maxTick : market.minTick;
                effectiveLimit = uint128(uint256(boundary) * market.tickSize);
            }
        }
        uint128 limitKey = _priceToKey(market, effectiveLimit);

        uint64 internalOrderId = _nextOrderId++;
        StoredOrder storage incoming = _orders[internalOrderId];
        incoming.marketId = id;
        incoming.trader = request.trader;
        incoming.price = effectiveLimit;
        incoming.quantity = request.quantity;
        incoming.remaining = request.quantity;
        incoming.clientOrderId = request.clientOrderId;
        incoming.createdAt = uint64(block.timestamp);
        incoming.side = request.side;
        incoming.status = OrderStatus.Open;
        _indexUserOrder(internalOrderId, incoming);

        orderId = bytes32(uint256(internalOrderId));
        _emitOrderPlaced(orderId, incoming, market);
        quoteQuantity = _match(id, internalOrderId, incoming, limitKey, maxBookSteps, true);
        filledQuantity = request.quantity - incoming.remaining;
        if (filledQuantity == 0) revert NoLiquidity();
        if (filledQuantity < request.minFillQuantity) revert MinimumFillNotMet();

        if (incoming.remaining != 0) {
            incoming.status =
                filledQuantity == 0 ? OrderStatus.Cancelled : OrderStatus.PartiallyFilled;
        }

        emit MarketOrderExecuted(
            orderId,
            id,
            request.trader,
            request.side,
            request.quantity,
            filledQuantity,
            quoteQuantity
        );
        _emitBookUpdated(id);
    }

    function cancelOrder(bytes32 externalOrderId) external nonReentrant {
        uint64 orderId_ = _decodeOrderId(externalOrderId);
        StoredOrder storage order = _orders[orderId_];
        if (order.trader == address(0)) revert InvalidOrder();
        if (msg.sender != order.trader) revert Unauthorized();
        if (order.status != OrderStatus.Open && order.status != OrderStatus.PartiallyFilled) {
            revert OrderNotOpen();
        }
        if (!order.resting) revert OrderNotOpen();

        _cancelRestingOrder(orderId_, order);
        _emitBookUpdated(order.marketId);
    }

    function withdrawTradingFees(address asset, address recipient, uint256 amount)
        external
        override
        nonReentrant
    {
        if (msg.sender != feeRecipient) revert Unauthorized();
        if (recipient == address(0) || amount == 0) revert InvalidFeeWithdrawal();
        uint256 accrued = accruedTradingFees[asset];
        if (amount > accrued) revert InsufficientAccruedFees();
        accruedTradingFees[asset] = accrued - amount;
        _pushAsset(asset, recipient, amount);
        emit TradingFeesWithdrawn(asset, recipient, amount);
    }

    function getOrder(bytes32 externalOrderId)
        external
        view
        returns (LimitOrder memory order, OrderState memory state)
    {
        uint256 rawOrderId = uint256(externalOrderId);
        if (rawOrderId == 0 || rawOrderId > type(uint64).max) return (order, state);

        StoredOrder storage stored = _orders[uint64(rawOrderId)];
        if (stored.trader == address(0)) return (order, state);
        return _readOrder(stored);
    }

    function getUserOrderIds(
        bytes32 id,
        address trader,
        bytes32 cursor,
        uint16 limit,
        uint8 statusFlags
    ) external view returns (bytes32[] memory orderIds, bytes32 nextCursor) {
        (uint64[] memory internalIds, uint64 nextInternalId) =
            _filteredUserOrderIds(id, trader, cursor, limit, statusFlags);
        orderIds = new bytes32[](internalIds.length);
        for (uint256 i; i < internalIds.length; ++i) {
            orderIds[i] = bytes32(uint256(internalIds[i]));
        }
        nextCursor = bytes32(uint256(nextInternalId));
    }

    function _filteredUserOrderIds(
        bytes32 id,
        address trader,
        bytes32 cursor,
        uint16 limit,
        uint8 statusFlags
    ) private view returns (uint64[] memory orderIds, uint64 nextOrderId) {
        if (!_markets[id].enabled) revert InvalidMarket();
        if (limit == 0) revert InvalidPageSize();
        if (limit > MAX_VIEW_DEPTH) revert ViewDepthTooLarge();
        if (statusFlags == 0 || statusFlags & ~_USER_ORDER_FLAGS_ALL != 0) {
            revert InvalidOrderFlags();
        }

        uint64 current = _userOrderStart(id, trader, cursor);
        orderIds = new uint64[](limit);
        uint256 count;
        uint256 scanned;

        // Bound both returned results and inspected history. A selective filter can
        // therefore return an empty page with a non-zero cursor for the next scan.
        while (current != 0 && count < limit && scanned < MAX_VIEW_DEPTH) {
            StoredOrder storage order = _orders[current];
            uint64 next = order.nextUserOrderId;
            if (_userOrderFlag(order) & statusFlags != 0) {
                orderIds[count] = current;
                unchecked {
                    ++count;
                }
            }
            current = next;
            unchecked {
                ++scanned;
            }
        }

        assembly ("memory-safe") {
            mstore(orderIds, count)
        }
        nextOrderId = current;
    }

    function _userOrderStart(bytes32 id, address trader, bytes32 cursor)
        private
        view
        returns (uint64 orderId_)
    {
        if (cursor == bytes32(0)) return _userOrderHead[trader][id];
        uint256 rawOrderId = uint256(cursor);
        if (rawOrderId > type(uint64).max) revert InvalidOrder();
        orderId_ = uint64(rawOrderId);
        StoredOrder storage order = _orders[orderId_];
        if (order.trader != trader || order.marketId != id) revert InvalidOrder();
    }

    function _userOrderFlag(StoredOrder storage order) private view returns (uint8) {
        if (order.resting) return USER_ORDER_FLAG_OPEN;
        if (order.status == OrderStatus.Filled) return USER_ORDER_FLAG_FILLED;
        return USER_ORDER_FLAG_CANCELED;
    }

    function _readOrder(StoredOrder storage stored)
        private
        view
        returns (LimitOrder memory order, OrderState memory state)
    {
        Market storage market = _markets[stored.marketId];
        order = LimitOrder({
            trader: stored.trader,
            baseAsset: market.baseAsset,
            quoteAsset: market.quoteAsset,
            side: stored.side,
            price: stored.price,
            quantity: stored.quantity,
            expiry: stored.expiry,
            clientOrderId: stored.clientOrderId
        });
        state = OrderState({
            quantity: stored.quantity,
            filledQuantity: stored.quantity - stored.remaining,
            createdAt: stored.createdAt,
            status: stored.status
        });
    }

    function _indexUserOrder(uint64 orderId_, StoredOrder storage order) private {
        uint64 previousHead = _userOrderHead[order.trader][order.marketId];
        order.nextUserOrderId = previousHead;
        _userOrderHead[order.trader][order.marketId] = orderId_;
    }

    function getBestPrices(bytes32 id)
        external
        view
        returns (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        )
    {
        Market storage market = _markets[id];
        if (!market.enabled) revert InvalidMarket();
        return _getBestPrices(id, market);
    }

    function getPriceLevel(bytes32 id, Side side, uint128 price)
        external
        view
        returns (uint128 totalQuantity, bytes32 headOrderId, bytes32 tailOrderId)
    {
        Market storage market = _markets[id];
        uint128 key = _priceToKey(market, price);
        PriceLevel storage level = _sideBook(id, side).levels[key];
        return (
            level.totalQuantity,
            bytes32(uint256(level.headOrderId)),
            bytes32(uint256(level.tailOrderId))
        );
    }

    function getOrderLinks(bytes32 externalOrderId)
        external
        view
        returns (bytes32 previousOrderId, bytes32 nextOrderId, bool resting)
    {
        uint256 rawOrderId = uint256(externalOrderId);
        if (rawOrderId == 0 || rawOrderId > type(uint64).max) {
            return (bytes32(0), bytes32(0), false);
        }
        StoredOrder storage order = _orders[uint64(rawOrderId)];
        return (
            bytes32(uint256(order.previousOrderId)),
            bytes32(uint256(order.nextOrderId)),
            order.resting
        );
    }

    function isPriceLevelActive(bytes32 id, Side side, uint128 price) external view returns (bool) {
        Market storage market = _markets[id];
        uint128 key = _priceToKey(market, price);
        return _containsPrice(_sideBook(id, side), market, key);
    }

    function getOrderBook(bytes32 id, uint16 depth)
        external
        view
        returns (PriceLevelView[] memory bids, PriceLevelView[] memory asks)
    {
        if (depth > MAX_VIEW_DEPTH) revert ViewDepthTooLarge();
        Market storage market = _markets[id];
        if (!market.enabled) revert InvalidMarket();
        bids = _readSide(id, market, Side.Buy, depth);
        asks = _readSide(id, market, Side.Sell, depth);
    }

    function _getBestPrices(bytes32 id, Market storage market)
        private
        view
        returns (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        )
    {
        uint128 bidKey;
        uint128 askKey;
        (bidExists, bidKey) = _maximumPrice(_books[id].bids, market);
        (askExists, askKey) = _minimumPrice(_books[id].asks, market);
        if (bidExists) {
            bidPrice = _keyToPrice(market, bidKey);
            bidQuantity = _books[id].bids.levels[bidKey].totalQuantity;
        }
        if (askExists) {
            askPrice = _keyToPrice(market, askKey);
            askQuantity = _books[id].asks.levels[askKey].totalQuantity;
        }
    }

    function _readSide(bytes32 id, Market storage market, Side side, uint16 depth)
        private
        view
        returns (PriceLevelView[] memory levels)
    {
        levels = new PriceLevelView[](depth);
        if (depth == 0) return levels;

        SideBook storage book = _sideBook(id, side);
        (bool exists, uint128 key) =
            side == Side.Buy ? _maximumPrice(book, market) : _minimumPrice(book, market);
        uint256 count;

        while (exists && count < depth) {
            levels[count] = PriceLevelView({
                price: _keyToPrice(market, key), quantity: book.levels[key].totalQuantity
            });
            unchecked {
                ++count;
            }
            (exists, key) = side == Side.Buy
                ? _previousPrice(book, market, key)
                : _nextPrice(book, market, key);
        }

        assembly ("memory-safe") {
            mstore(levels, count)
        }
    }

    function _placeLimitOrder(LimitOrder calldata request, uint32 maxBookSteps)
        private
        returns (bytes32 externalOrderId)
    {
        if (
            request.trader == address(0) || request.quantity == 0 || request.price == 0
                || (request.expiry != 0 && request.expiry <= block.timestamp)
        ) revert InvalidOrder();
        if (msg.sender != request.trader) revert Unauthorized();

        bytes32 id = marketId(request.baseAsset, request.quoteAsset);
        Market storage market = _markets[id];
        if (
            !market.enabled || request.baseAsset != market.baseAsset
                || request.quoteAsset != market.quoteAsset
        ) revert InvalidMarket();
        uint128 priceKey = _priceToKey(market, request.price);
        if (market.agnosticPricing && _quoteAmount(market, request.price, request.quantity) == 0) {
            revert InvalidLotQuantity();
        }

        (uint256 feeReserve, uint256 escrowAmount) = _escrowOrderFunds(request, market);

        uint64 orderId_ = _nextOrderId++;
        StoredOrder storage incoming = _orders[orderId_];
        incoming.marketId = id;
        incoming.trader = request.trader;
        incoming.price = request.price;
        incoming.quantity = request.quantity;
        incoming.remaining = request.quantity;
        incoming.expiry = request.expiry;
        incoming.clientOrderId = request.clientOrderId;
        incoming.createdAt = uint64(block.timestamp);
        incoming.side = request.side;
        incoming.status = OrderStatus.Open;
        incoming.feeReserve = feeReserve;
        incoming.escrowRemaining = escrowAmount;
        _indexUserOrder(orderId_, incoming);

        externalOrderId = bytes32(uint256(orderId_));
        _emitOrderPlaced(externalOrderId, incoming, market);

        _match(id, orderId_, incoming, priceKey, maxBookSteps, false);
        _releaseFeeReserve(incoming, market);
        if (incoming.remaining != 0) {
            if (
                market.agnosticPricing
                    && _quoteAmount(market, incoming.price, incoming.remaining) == 0
            ) {
                _releaseUnrestedRemainder(orderId_, incoming, market);
            } else {
                _appendOrder(id, priceKey, orderId_, incoming);
            }
        }
    }

    function _emitOrderPlaced(
        bytes32 externalOrderId,
        StoredOrder storage order,
        Market storage market
    ) private {
        emit OrderPlaced(
            externalOrderId,
            order.trader,
            order.marketId,
            market.baseAsset,
            market.quoteAsset,
            order.side,
            order.price,
            order.quantity,
            order.expiry,
            order.clientOrderId
        );
    }

    function _match(
        bytes32 id,
        uint64 takerOrderId,
        StoredOrder storage taker,
        uint128 takerKey,
        uint32 maxBookSteps,
        bool takerUsesWallet
    ) private returns (uint256 quoteQuantity) {
        uint32 steps;

        while (taker.remaining != 0) {
            (bool exists, uint128 makerKey) = _bestOppositePrice(id, taker.side);
            if (!exists || !_crosses(taker.side, takerKey, makerKey)) break;
            if (steps == maxBookSteps) revert MatchLimitExceeded();
            unchecked {
                ++steps;
            }

            (uint256 matchedQuote, bool progressed) =
                _matchOne(id, takerOrderId, taker, makerKey, takerUsesWallet);
            if (!progressed) break;
            quoteQuantity += matchedQuote;
        }
    }

    function _matchOne(
        bytes32 id,
        uint64 takerOrderId,
        StoredOrder storage taker,
        uint128 makerKey,
        bool takerUsesWallet
    ) private returns (uint256 tradedQuote, bool progressed) {
        PriceLevel storage level = _sideBook(id, _opposite(taker.side)).levels[makerKey];
        uint64 makerOrderId = level.headOrderId;
        StoredOrder storage maker = _orders[makerOrderId];

        if (maker.expiry != 0 && maker.expiry <= block.timestamp) {
            _cancelRestingOrder(makerOrderId, maker);
            return (0, true);
        }

        uint128 fillQuantity = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;
        uint128 executionPrice = maker.price;
        Market storage market = _markets[id];
        tradedQuote = _quoteAmount(market, executionPrice, fillQuantity);
        if (tradedQuote == 0) return (0, false);
        uint256 tradingFee;
        if (takerUsesWallet) {
            tradingFee = _settleMarketTaker(market, taker, maker, executionPrice, fillQuantity);
        } else {
            tradingFee = _settleMatch(market, taker, maker, executionPrice, fillQuantity);
        }

        taker.remaining -= fillQuantity;
        maker.remaining -= fillQuantity;
        level.totalQuantity -= fillQuantity;
        taker.status = taker.remaining == 0 ? OrderStatus.Filled : OrderStatus.PartiallyFilled;
        maker.status = maker.remaining == 0 ? OrderStatus.Filled : OrderStatus.PartiallyFilled;

        _emitTradeExecuted(
            id, takerOrderId, makerOrderId, executionPrice, fillQuantity, tradedQuote
        );
        _emitTradingFeeCharged(id, takerOrderId, tradingFee);
        _emitTradingFeeCharged(id, makerOrderId, tradingFee);
        _emitOrderFill(id, takerOrderId, taker, fillQuantity);
        _emitOrderFill(id, makerOrderId, maker, fillQuantity);

        if (maker.remaining == 0) {
            _releaseFeeReserve(maker, market);
            _unlinkOrder(id, makerKey, maker);
        } else if (
            market.agnosticPricing && _quoteAmount(market, maker.price, maker.remaining) == 0
        ) {
            _cancelRestingOrder(makerOrderId, maker);
        }
        return (tradedQuote, true);
    }

    function _emitTradeExecuted(
        bytes32 id,
        uint64 takerOrderId,
        uint64 makerOrderId,
        uint128 executionPrice,
        uint128 fillQuantity,
        uint256 tradedQuote
    ) private {
        Market storage market = _markets[id];
        emit TradeExecuted(
            id,
            bytes32(uint256(takerOrderId)),
            bytes32(uint256(makerOrderId)),
            market.baseAsset,
            market.quoteAsset,
            executionPrice,
            fillQuantity,
            tradedQuote
        );
    }

    function _emitTradingFeeCharged(bytes32 id, uint64 orderId_, uint256 tradingFee) private {
        emit TradingFeeCharged(
            id,
            bytes32(uint256(orderId_)),
            _orders[orderId_].trader,
            _markets[id].quoteAsset,
            tradingFee
        );
    }

    function _emitOrderFill(
        bytes32 id,
        uint64 orderId_,
        StoredOrder storage order,
        uint128 fillQuantity
    ) private {
        if (order.remaining == 0) {
            emit OrderFilled(id, bytes32(uint256(orderId_)), fillQuantity, order.quantity);
        } else {
            emit OrderPartiallyFilled(id, bytes32(uint256(orderId_)), fillQuantity, order.remaining);
        }
    }

    function _escrowOrderFunds(LimitOrder calldata order, Market storage market)
        private
        returns (uint256 feeReserve, uint256 escrowAmount)
    {
        address asset;
        if (order.side == Side.Buy) {
            asset = market.quoteAsset;
            escrowAmount = _quoteAmount(market, order.price, order.quantity);
            feeReserve = _tradingFee(escrowAmount, market.tradingFeeBps);
        } else {
            asset = market.baseAsset;
            escrowAmount = _baseAmount(market, order.quantity);
        }

        uint256 amount = escrowAmount + feeReserve;
        _pullAsset(asset, order.trader, amount);
        _balances[order.trader][asset].locked += amount;
        emit OrderEscrowed(order.trader, asset, amount);
    }

    function _settleMatch(
        Market storage market,
        StoredOrder storage taker,
        StoredOrder storage maker,
        uint128 executionPrice,
        uint128 quantity
    ) private returns (uint256 tradingFee) {
        uint256 tradedQuote = _quoteAmount(market, executionPrice, quantity);
        uint256 tradedBase = _baseAmount(market, quantity);
        tradingFee = _tradingFee(tradedQuote, market.tradingFeeBps);

        if (taker.side == Side.Buy) {
            uint256 reservedQuote = _consumeBuyEscrow(taker, market, quantity);
            Balance storage buyerQuote = _balances[taker.trader][market.quoteAsset];
            buyerQuote.locked -= reservedQuote + tradingFee;
            taker.feeReserve -= tradingFee;
            _balances[maker.trader][market.baseAsset].locked -= tradedBase;
            maker.escrowRemaining -= tradedBase;

            _pushAsset(market.baseAsset, taker.trader, tradedBase);
            _pushAsset(market.quoteAsset, maker.trader, tradedQuote - tradingFee);
            uint256 priceImprovement = reservedQuote - tradedQuote;
            if (priceImprovement != 0) {
                _pushAsset(market.quoteAsset, taker.trader, priceImprovement);
            }
        } else {
            uint256 reservedQuote = _consumeBuyEscrow(maker, market, quantity);
            Balance storage buyerQuote = _balances[maker.trader][market.quoteAsset];
            maker.feeReserve -= tradingFee;
            buyerQuote.locked -= reservedQuote + tradingFee;
            _balances[taker.trader][market.baseAsset].locked -= tradedBase;
            taker.escrowRemaining -= tradedBase;

            _pushAsset(market.baseAsset, maker.trader, tradedBase);
            _pushAsset(market.quoteAsset, taker.trader, tradedQuote - tradingFee);
            uint256 roundingRefund = reservedQuote - tradedQuote;
            if (roundingRefund != 0) {
                _pushAsset(market.quoteAsset, maker.trader, roundingRefund);
            }
        }
        accruedTradingFees[market.quoteAsset] += tradingFee << 1;
    }

    function _settleMarketTaker(
        Market storage market,
        StoredOrder storage taker,
        StoredOrder storage maker,
        uint128 executionPrice,
        uint128 quantity
    ) private returns (uint256 tradingFee) {
        uint256 tradedQuote = _quoteAmount(market, executionPrice, quantity);
        uint256 tradedBase = _baseAmount(market, quantity);
        tradingFee = _tradingFee(tradedQuote, market.tradingFeeBps);

        if (taker.side == Side.Buy) {
            _balances[maker.trader][market.baseAsset].locked -= tradedBase;
            maker.escrowRemaining -= tradedBase;
            _pullAsset(market.quoteAsset, taker.trader, tradedQuote + tradingFee);
            _pushAsset(market.baseAsset, taker.trader, tradedBase);
            _pushAsset(market.quoteAsset, maker.trader, tradedQuote - tradingFee);
        } else {
            uint256 reservedQuote = _consumeBuyEscrow(maker, market, quantity);
            Balance storage buyerQuote = _balances[maker.trader][market.quoteAsset];
            maker.feeReserve -= tradingFee;
            buyerQuote.locked -= reservedQuote + tradingFee;
            _pullAsset(market.baseAsset, taker.trader, tradedBase);
            _pushAsset(market.baseAsset, maker.trader, tradedBase);
            _pushAsset(market.quoteAsset, taker.trader, tradedQuote - tradingFee);
            uint256 roundingRefund = reservedQuote - tradedQuote;
            if (roundingRefund != 0) {
                _pushAsset(market.quoteAsset, maker.trader, roundingRefund);
            }
        }
        accruedTradingFees[market.quoteAsset] += tradingFee << 1;
    }

    function _consumeBuyEscrow(
        StoredOrder storage buyer,
        Market storage market,
        uint128 fillQuantity
    ) private returns (uint256 consumed) {
        uint128 remainingAfter = buyer.remaining - fillQuantity;
        uint256 targetEscrow = _quoteAmount(market, buyer.price, remainingAfter);
        consumed = buyer.escrowRemaining - targetEscrow;
        buyer.escrowRemaining = targetEscrow;
    }

    function _releaseFeeReserve(StoredOrder storage order, Market storage market) private {
        uint256 target = order.side == Side.Buy
            ? _tradingFee(_quoteAmount(market, order.price, order.remaining), market.tradingFeeBps)
            : 0;
        uint256 amount = order.feeReserve - target;
        if (amount == 0) return;
        order.feeReserve = target;
        _balances[order.trader][market.quoteAsset].locked -= amount;
        _pushAsset(market.quoteAsset, order.trader, amount);
        emit OrderEscrowReleased(order.trader, market.quoteAsset, amount);
    }

    function _releaseUnrestedRemainder(
        uint64 orderId_,
        StoredOrder storage order,
        Market storage market
    ) private {
        address asset = order.side == Side.Buy ? market.quoteAsset : market.baseAsset;
        uint256 amount = order.escrowRemaining + order.feeReserve;
        order.escrowRemaining = 0;
        order.feeReserve = 0;
        if (amount != 0) {
            _balances[order.trader][asset].locked -= amount;
            _pushAsset(asset, order.trader, amount);
            emit OrderEscrowReleased(order.trader, asset, amount);
        }
        order.status = OrderStatus.Cancelled;
        emit OrderCancelled(
            bytes32(uint256(orderId_)), order.marketId, order.trader, order.remaining
        );
    }

    function _tradingFee(uint256 quoteQuantity, uint16 tradingFeeBps)
        private
        pure
        returns (uint256)
    {
        uint256 whole = quoteQuantity / BPS_DENOMINATOR;
        uint256 remainder = quoteQuantity % BPS_DENOMINATOR;
        return whole * tradingFeeBps + (remainder * tradingFeeBps) / BPS_DENOMINATOR;
    }

    function _appendOrder(bytes32 id, uint128 priceKey, uint64 orderId_, StoredOrder storage order)
        private
    {
        SideBook storage book = _sideBook(id, order.side);
        Market storage market = _markets[id];
        PriceLevel storage level = book.levels[priceKey];
        uint64 oldTail = level.tailOrderId;

        if (oldTail == 0) {
            level.headOrderId = orderId_;
            _setPrice(book, market, priceKey);
        } else {
            _orders[oldTail].nextOrderId = orderId_;
            order.previousOrderId = oldTail;
        }
        level.tailOrderId = orderId_;
        level.totalQuantity += order.remaining;
        order.resting = true;
    }

    function _cancelRestingOrder(uint64 orderId_, StoredOrder storage order) private {
        Market storage market = _markets[order.marketId];
        uint128 priceKey = _priceToKey(market, order.price);
        PriceLevel storage level = _sideBook(order.marketId, order.side).levels[priceKey];
        level.totalQuantity -= order.remaining;

        address asset = order.side == Side.Buy ? market.quoteAsset : market.baseAsset;
        uint256 amount = order.escrowRemaining + order.feeReserve;
        order.escrowRemaining = 0;
        order.feeReserve = 0;
        Balance storage balance = _balances[order.trader][asset];
        balance.locked -= amount;
        _pushAsset(asset, order.trader, amount);
        emit OrderEscrowReleased(order.trader, asset, amount);

        _unlinkOrder(order.marketId, priceKey, order);
        order.status = OrderStatus.Cancelled;
        emit OrderCancelled(
            bytes32(uint256(orderId_)), order.marketId, order.trader, order.remaining
        );
    }

    function _unlinkOrder(bytes32 id, uint128 priceKey, StoredOrder storage order) private {
        SideBook storage book = _sideBook(id, order.side);
        PriceLevel storage level = book.levels[priceKey];
        uint64 previous = order.previousOrderId;
        uint64 next = order.nextOrderId;

        if (previous == 0) level.headOrderId = next;
        else _orders[previous].nextOrderId = next;

        if (next == 0) level.tailOrderId = previous;
        else _orders[next].previousOrderId = previous;

        order.previousOrderId = 0;
        order.nextOrderId = 0;
        order.resting = false;

        if (level.headOrderId == 0) {
            _clearPrice(book, _markets[id], priceKey);
            delete book.levels[priceKey];
        }
    }

    function _bestOppositePrice(bytes32 id, Side takerSide)
        private
        view
        returns (bool exists, uint128 priceKey)
    {
        Market storage market = _markets[id];
        if (takerSide == Side.Buy) return _minimumPrice(_books[id].asks, market);
        return _maximumPrice(_books[id].bids, market);
    }

    function _sideBook(bytes32 id, Side side) private view returns (SideBook storage book) {
        if (side == Side.Buy) return _books[id].bids;
        return _books[id].asks;
    }

    function _crosses(Side takerSide, uint128 takerKey, uint128 makerKey)
        private
        pure
        returns (bool)
    {
        if (takerSide == Side.Buy) return takerKey >= makerKey;
        return takerKey <= makerKey;
    }

    function _opposite(Side side) private pure returns (Side) {
        return side == Side.Buy ? Side.Sell : Side.Buy;
    }

    function _quoteAmount(Market storage market, uint128 price, uint128 quantity)
        private
        view
        returns (uint256)
    {
        if (!market.agnosticPricing) return uint256(price) * quantity;
        return SpotPriceMath.quoteAmount(price, quantity, market.baseDecimals, market.quoteDecimals);
    }

    function _baseAmount(Market storage market, uint128 quantity) private view returns (uint256) {
        if (market.agnosticPricing) return quantity;
        return uint256(market.lotSize) * quantity;
    }

    function _keyToPrice(Market storage market, uint128 key) private view returns (uint128) {
        if (market.agnosticPricing) return key;
        return uint128(uint256(key) * market.tickSize);
    }

    function _containsPrice(SideBook storage book, Market storage market, uint128 key)
        private
        view
        returns (bool)
    {
        if (market.agnosticPricing) return book.widePrices.contains(key);
        return book.legacyTicks.contains(uint24(key));
    }

    function _setPrice(SideBook storage book, Market storage market, uint128 key) private {
        if (market.agnosticPricing) book.widePrices.set(key);
        else book.legacyTicks.set(uint24(key));
    }

    function _clearPrice(SideBook storage book, Market storage market, uint128 key) private {
        if (market.agnosticPricing) book.widePrices.clear(key);
        else book.legacyTicks.clear(uint24(key));
    }

    function _minimumPrice(SideBook storage book, Market storage market)
        private
        view
        returns (bool exists, uint128 key)
    {
        if (market.agnosticPricing) return book.widePrices.min();
        uint24 tick;
        (exists, tick) = book.legacyTicks.min();
        return (exists, tick);
    }

    function _maximumPrice(SideBook storage book, Market storage market)
        private
        view
        returns (bool exists, uint128 key)
    {
        if (market.agnosticPricing) return book.widePrices.max();
        uint24 tick;
        (exists, tick) = book.legacyTicks.max();
        return (exists, tick);
    }

    function _nextPrice(SideBook storage book, Market storage market, uint128 key)
        private
        view
        returns (bool exists, uint128 nextKey)
    {
        if (market.agnosticPricing) return book.widePrices.next(key);
        uint24 tick;
        (exists, tick) = book.legacyTicks.next(uint24(key));
        return (exists, tick);
    }

    function _previousPrice(SideBook storage book, Market storage market, uint128 key)
        private
        view
        returns (bool exists, uint128 previousKey)
    {
        if (market.agnosticPricing) return book.widePrices.previous(key);
        uint24 tick;
        (exists, tick) = book.legacyTicks.previous(uint24(key));
        return (exists, tick);
    }

    function _priceToKey(Market storage market, uint128 price) private view returns (uint128 key) {
        if (!market.enabled) revert InvalidMarket();
        if (market.agnosticPricing) {
            if (price == 0) revert InvalidTick();
            return price;
        }
        if (price == 0 || price % market.tickSize != 0) revert InvalidTick();
        uint256 rawTick = price / market.tickSize;
        if (rawTick < market.minTick || rawTick > market.maxTick) revert InvalidTick();
        return uint128(rawTick);
    }

    function _emitBookUpdated(bytes32 id) private {
        Market storage market = _markets[id];
        (bool bidExists, uint128 bestBid,,, uint128 bestAsk,) = _getBestPrices(id, market);
        // A missing side is represented by zero in this lightweight update event.
        if (!bidExists) bestBid = 0;
        uint64 sequence = ++bookSequence[id];
        emit BookUpdated(id, bestBid, bestAsk, sequence);
    }

    function _decodeOrderId(bytes32 externalOrderId) private pure returns (uint64 orderId_) {
        uint256 rawOrderId = uint256(externalOrderId);
        if (rawOrderId == 0 || rawOrderId > type(uint64).max) revert InvalidOrder();
        return uint64(rawOrderId);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _pullAsset(address asset, address from, uint256 amount) private {
        if (!_supportedAssets[asset]) revert UnsupportedAsset();
        uint256 beforeBalance = IERC20Minimal(asset).balanceOf(address(this));
        _safeTransferFrom(asset, from, address(this), amount);
        if (IERC20Minimal(asset).balanceOf(address(this)) - beforeBalance != amount) {
            revert UnsupportedTokenBehavior();
        }
    }

    function _pushAsset(address asset, address to, uint256 amount) private {
        uint256 contractBalanceBefore = IERC20Minimal(asset).balanceOf(address(this));
        uint256 recipientBalanceBefore = IERC20Minimal(asset).balanceOf(to);
        _safeTransfer(asset, to, amount);
        uint256 contractBalanceAfter = IERC20Minimal(asset).balanceOf(address(this));
        uint256 recipientBalanceAfter = IERC20Minimal(asset).balanceOf(to);
        if (
            contractBalanceBefore - contractBalanceAfter != amount
                || recipientBalanceAfter - recipientBalanceBefore != amount
        ) revert UnsupportedTokenBehavior();
    }
}
