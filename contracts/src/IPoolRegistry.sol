// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read seam used by a spot CLOB to load its immutable pair configuration.
interface IPoolRegistry {
    struct Pool {
        address baseAsset;
        address quoteAsset;
        address book;
        uint128 lotSize;
        uint128 tickSize;
        uint24 minTick;
        uint24 maxTick;
        uint16 tradingFeeBps;
        uint8 baseDecimals;
        uint8 quoteDecimals;
        bool agnosticPricing;
        bool exists;
    }

    function getPool(bytes32 id) external view returns (Pool memory);
}
