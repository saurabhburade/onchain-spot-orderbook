// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The matching boundary for a fully on-chain spot central limit order book.
/// @dev Implementations must perform price-time matching and settlement on-chain.
interface ISpotCLOB {
    enum Side {
        Buy,
        Sell
    }

    enum OrderKind {
        Limit,
        Market
    }

    enum OrderStatus {
        Unknown,
        Open,
        PartiallyFilled,
        Filled,
        Cancelled
    }

    struct LimitOrder {
        address trader;
        address baseAsset;
        address quoteAsset;
        Side side;
        /// @notice Legacy markets use quote atoms per lot. Agnostic markets use quote tokens per
        /// whole base token with 18 fixed decimals (`priceX18`).
        uint128 price;
        /// @notice Legacy markets use base lots. Agnostic markets use raw base-token atoms.
        uint128 quantity;
        uint64 expiry;
        uint64 clientOrderId;
    }

    struct OrderState {
        uint128 quantity;
        uint128 filledQuantity;
        uint64 createdAt;
        OrderStatus status;
        OrderKind kind;
        uint256 filledQuoteQuantity;
    }

    struct MarketOrder {
        address trader;
        address baseAsset;
        address quoteAsset;
        Side side;
        uint128 quantity;
        /// @notice Worst acceptable price. Zero uses the configured pool boundary.
        uint128 priceLimit;
        /// @notice Revert unless at least this many lots/raw base atoms execute.
        uint128 minFillQuantity;
        uint64 clientOrderId;
    }

    struct PriceLevelView {
        uint128 price;
        uint128 quantity;
    }

    struct UserOrderView {
        bytes32 orderId;
        LimitOrder order;
        OrderState state;
    }

    /// @notice Emitted after an order is accepted and assigned an exchange order id.
    event OrderPlaced(
        bytes32 indexed orderId,
        address indexed trader,
        bytes32 indexed poolId,
        address baseAsset,
        address quoteAsset,
        Side side,
        uint128 price,
        uint128 quantity,
        uint64 expiry,
        uint64 clientOrderId
    );

    /// @notice Emitted for every fill produced by a state-changing operation.
    event TradeExecuted(
        bytes32 indexed poolId,
        bytes32 indexed takerOrderId,
        bytes32 indexed makerOrderId,
        address baseAsset,
        address quoteAsset,
        uint128 price,
        uint128 quantity,
        uint256 quoteQuantity
    );

    event TradingFeeCharged(
        bytes32 indexed poolId,
        bytes32 indexed orderId,
        address indexed feePayer,
        address quoteAsset,
        uint256 amount
    );

    event TradingFeesWithdrawn(address indexed asset, address indexed recipient, uint256 amount);

    event TradingFeeUpdated(bytes32 indexed poolId, uint16 previousFeeBps, uint16 newFeeBps);

    event OrderFilled(
        bytes32 indexed poolId,
        bytes32 indexed orderId,
        uint128 fillQuantity,
        uint128 totalFilledQuantity
    );

    event OrderPartiallyFilled(
        bytes32 indexed poolId,
        bytes32 indexed orderId,
        uint128 fillQuantity,
        uint128 remainingQuantity
    );

    event MarketOrderExecuted(
        bytes32 indexed orderId,
        bytes32 indexed poolId,
        address indexed trader,
        Side side,
        uint128 requestedQuantity,
        uint128 filledQuantity,
        uint256 quoteQuantity
    );

    event BookUpdated(bytes32 indexed poolId, uint128 bestBid, uint128 bestAsk, uint64 sequence);

    /// @notice Emitted when an open order is cancelled by its owner or an authorized actor.
    event OrderCancelled(
        bytes32 indexed orderId,
        bytes32 indexed poolId,
        address indexed trader,
        uint128 remainingQuantity
    );

    /// @notice Place a limit order and match it against the resting book.
    /// @dev The implementation must reject invalid pairs, zero values, expired orders, and
    /// insufficient available balance before mutating the book.
    function placeLimitOrder(LimitOrder calldata order) external returns (bytes32 orderId);

    function placeLimitOrderWithMaxBookSteps(LimitOrder calldata order, uint32 maxBookSteps)
        external
        returns (bytes32 orderId);

    /// @notice Execute immediately against resting liquidity without placing a remainder on-book.
    /// @dev Reverts when no quantity can execute. A zero minimum permits a partial fill, not a zero
    /// fill.
    function executeMarketOrder(MarketOrder calldata order, uint32 maxBookSteps)
        external
        returns (bytes32 orderId, uint128 filledQuantity, uint256 quoteQuantity);

    /// @notice Cancel an order that still has resting quantity.
    /// @dev The caller must be the order owner.
    function cancelOrder(bytes32 orderId) external;

    /// @notice Withdraw quote-token trading fees accrued by this order book.
    /// @dev Only the immutable protocol fee recipient may call this function.
    function withdrawTradingFees(address asset, address recipient, uint256 amount) external;

    /// @notice Synchronize a factory-admin fee update into this order book.
    function setTradingFeeBps(bytes32 poolId, uint16 tradingFeeBps) external;

    function accruedTradingFees(address asset) external view returns (uint256);

    /// @notice Return wallet funds available to trade and funds escrowed by open orders.
    function balanceOf(address account, address asset)
        external
        view
        returns (uint256 free, uint256 locked, uint256 total);

    /// @notice Return the current order record and its lifecycle status.
    function getOrder(bytes32 orderId)
        external
        view
        returns (LimitOrder memory order, OrderState memory state);

    /// @notice Return a newest-first page of a trader's order ids for one market.
    /// @dev `cursor == 0` starts at the newest order. Status flags are a bitmask.
    function getUserOrderIds(
        bytes32 poolId,
        address trader,
        bytes32 cursor,
        uint16 limit,
        uint8 statusFlags
    ) external view returns (bytes32[] memory orderIds, bytes32 nextCursor);

    function getOrderBook(bytes32 poolId, uint16 depth)
        external
        view
        returns (PriceLevelView[] memory bids, PriceLevelView[] memory asks);

    function getBestPrices(bytes32 poolId)
        external
        view
        returns (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        );

    function getPriceLevel(bytes32 poolId, Side side, uint128 price)
        external
        view
        returns (uint128 totalQuantity, bytes32 headOrderId, bytes32 tailOrderId);

    function getOrderLinks(bytes32 orderId)
        external
        view
        returns (bytes32 previousOrderId, bytes32 nextOrderId, bool resting);

    function isPriceLevelActive(bytes32 poolId, Side side, uint128 price)
        external
        view
        returns (bool);
}
