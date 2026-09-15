// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolRegistry } from "./IPoolRegistry.sol";

/// @notice Factory and canonical registry for independently deployed spot order books.
interface ISpotCLOBFactory is IPoolRegistry {
    event DefaultLotDecimalsUpdated(uint8 previousLotDecimals, uint8 newLotDecimals);

    event PairLotDecimalsUpdated(
        bytes32 indexed pairId,
        address indexed baseAsset,
        address indexed quoteAsset,
        uint8 lotDecimals
    );

    event PairLotDecimalsCleared(
        bytes32 indexed pairId, address indexed baseAsset, address indexed quoteAsset
    );

    event QuoteTokenUpdated(address indexed token, bool allowed);

    event PairCreated(
        bytes32 indexed pairId,
        address indexed baseAsset,
        address indexed quoteAsset,
        address book,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick,
        uint16 tradingFeeBps
    );

    event DefaultTradingFeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);

    event PairTradingFeeUpdated(bytes32 indexed pairId, uint16 previousFeeBps, uint16 newFeeBps);

    event MarketCreationFeeUpdated(uint256 previousFee, uint256 newFee);

    event MarketCreationFeePaid(bytes32 indexed pairId, address indexed payer, uint256 amount);

    event MarketCreationFeesWithdrawn(address indexed recipient, uint256 amount);

    event AgnosticPricingConfigured(
        bytes32 indexed pairId, uint8 baseDecimals, uint8 quoteDecimals
    );

    function owner() external view returns (address);

    function defaultLotDecimals() external view returns (uint8);

    function defaultTradingFeeBps() external view returns (uint16);

    function marketCreationFee() external view returns (uint256);

    function setDefaultLotDecimals(uint8 lotDecimals) external;

    function setDefaultTradingFeeBps(uint16 tradingFeeBps) external;

    function setMarketCreationFee(uint256 newFee) external;

    function withdrawMarketCreationFees(address payable recipient, uint256 amount) external;

    function setPairTradingFeeBps(address baseAsset, address quoteAsset, uint16 tradingFeeBps)
        external;

    function setPairLotDecimals(address baseAsset, address quoteAsset, uint8 lotDecimals) external;

    function clearPairLotDecimals(address baseAsset, address quoteAsset) external;

    function pairLotDecimals(address baseAsset, address quoteAsset) external view returns (uint8);

    function pairLotSize(address baseAsset, address quoteAsset) external view returns (uint128);

    function setQuoteToken(address token, bool allowed) external;

    function isQuoteToken(address token) external view returns (bool);

    function pairId(address baseAsset, address quoteAsset) external pure returns (bytes32);

    /// @notice Create a supply-agnostic market using priceX18 and raw base-token quantities.
    function createPair(address baseAsset, address quoteAsset)
        external
        payable
        returns (bytes32 id, address book);

    /// @notice Create a supply-agnostic market with an explicit taker trading fee.
    function createPairWithFee(address baseAsset, address quoteAsset, uint16 tradingFeeBps)
        external
        payable
        returns (bytes32 id, address book);

    function createPair(
        address baseAsset,
        address quoteAsset,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) external payable returns (bytes32 id, address book);

    function createPairWithFee(
        address baseAsset,
        address quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick,
        uint16 tradingFeeBps
    ) external payable returns (bytes32 id, address book);

    /// @notice Create a pair with an explicit raw base-token lot size.
    /// @dev This supports multi-token lots needed to quote sub-atom per-token prices while every
    /// settled quote amount remains at least one quote-token atom.
    function createPair(
        address baseAsset,
        address quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) external payable returns (bytes32 id, address book);

    function getPool(address baseAsset, address quoteAsset) external view returns (Pool memory);

    function getPair(bytes32 id) external view returns (address);

    function getPair(address baseAsset, address quoteAsset) external view returns (address);

    function allPairsLength() external view returns (uint256);

    function pairAt(uint256 index) external view returns (bytes32);

    function predictPairAddress(address baseAsset, address quoteAsset)
        external
        view
        returns (address);
}
