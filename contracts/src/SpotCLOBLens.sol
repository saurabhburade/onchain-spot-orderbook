// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISpotCLOB } from "./ISpotCLOB.sol";
import { SpotCLOB } from "./SpotCLOB.sol";
import { SpotPriceMath } from "./libraries/SpotPriceMath.sol";

/// @notice Stateless batched reads for SpotCLOB markets.
/// @dev The EVM cannot read another contract's storage slots directly. This lens deliberately uses
/// the book's stable view API, avoiding a dependency on its private storage layout.
contract SpotCLOBLens {
    error InvalidMarket();

    struct MarketSnapshot {
        SpotCLOB.Market market;
        uint64 sequence;
        bool bidExists;
        uint128 bidPrice;
        uint128 bidQuantity;
        bool askExists;
        uint128 askPrice;
        uint128 askQuantity;
        ISpotCLOB.PriceLevelView[] bids;
        ISpotCLOB.PriceLevelView[] asks;
    }

    struct OrderSnapshot {
        ISpotCLOB.LimitOrder order;
        ISpotCLOB.OrderState state;
        bytes32 previousOrderId;
        bytes32 nextOrderId;
        bool resting;
    }

    function getMarketSnapshot(SpotCLOB book, address baseAsset, address quoteAsset, uint16 depth)
        external
        view
        returns (MarketSnapshot memory snapshot)
    {
        bytes32 id = book.marketId(baseAsset, quoteAsset);
        snapshot.market = book.getMarket(baseAsset, quoteAsset);
        snapshot.sequence = book.bookSequence(id);
        (
            snapshot.bidExists,
            snapshot.bidPrice,
            snapshot.bidQuantity,
            snapshot.askExists,
            snapshot.askPrice,
            snapshot.askQuantity
        ) = book.getBestPrices(id);
        (snapshot.bids, snapshot.asks) = book.getOrderBook(id, depth);
    }

    function getOrderSnapshot(SpotCLOB book, bytes32 orderId)
        external
        view
        returns (OrderSnapshot memory snapshot)
    {
        (snapshot.order, snapshot.state) = book.getOrder(orderId);
        (snapshot.previousOrderId, snapshot.nextOrderId, snapshot.resting) =
            book.getOrderLinks(orderId);
    }

    function quoteAmount(
        SpotCLOB book,
        address baseAsset,
        address quoteAsset,
        uint128 price,
        uint128 quantity
    ) external view returns (uint256) {
        SpotCLOB.Market memory market = book.getMarket(baseAsset, quoteAsset);
        if (!market.enabled || price == 0 || quantity == 0) revert InvalidMarket();
        if (!market.agnosticPricing) return uint256(price) * quantity;
        return SpotPriceMath.quoteAmount(price, quantity, market.baseDecimals, market.quoteDecimals);
    }

    function minimumOrderQuantity(
        SpotCLOB book,
        address baseAsset,
        address quoteAsset,
        uint128 price
    ) external view returns (uint128) {
        SpotCLOB.Market memory market = book.getMarket(baseAsset, quoteAsset);
        if (!market.enabled || price == 0) revert InvalidMarket();
        if (!market.agnosticPricing) return 1;
        return SpotPriceMath.minimumBaseQuantity(price, market.baseDecimals, market.quoteDecimals);
    }

    function getUserOrders(
        SpotCLOB book,
        bytes32 marketId,
        address trader,
        bytes32 cursor,
        uint16 limit,
        uint8 statusFlags
    ) external view returns (ISpotCLOB.UserOrderView[] memory orders, bytes32 nextCursor) {
        bytes32[] memory orderIds;
        (orderIds, nextCursor) = book.getUserOrderIds(marketId, trader, cursor, limit, statusFlags);
        orders = new ISpotCLOB.UserOrderView[](orderIds.length);
        for (uint256 i; i < orderIds.length; ++i) {
            (ISpotCLOB.LimitOrder memory order, ISpotCLOB.OrderState memory state) =
                book.getOrder(orderIds[i]);
            orders[i] =
                ISpotCLOB.UserOrderView({ orderId: orderIds[i], order: order, state: state });
        }
    }
}
