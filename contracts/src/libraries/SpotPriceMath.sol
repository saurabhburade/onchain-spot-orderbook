// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Converts supply-agnostic per-token prices and raw base quantities into quote atoms.
library SpotPriceMath {
    error UnsupportedDecimalRelationship(uint8 baseDecimals, uint8 quoteDecimals);

    uint8 internal constant PRICE_DECIMALS = 18;
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice Quote atoms settled for `baseQuantity` raw base atoms, rounded down.
    /// @param priceX18 Quote tokens per whole base token with 18 fixed decimals.
    function quoteAmount(
        uint128 priceX18,
        uint128 baseQuantity,
        uint8 baseDecimals,
        uint8 quoteDecimals
    ) internal pure returns (uint256) {
        uint256 denominator = quoteDenominator(baseDecimals, quoteDecimals);
        // uint128 * uint128 always fits in uint256.
        return uint256(priceX18) * baseQuantity / denominator;
    }

    /// @notice Smallest raw base quantity that settles at least one quote-token atom.
    function minimumBaseQuantity(uint128 priceX18, uint8 baseDecimals, uint8 quoteDecimals)
        internal
        pure
        returns (uint128 quantity)
    {
        if (priceX18 == 0) return 0;
        uint256 denominator = quoteDenominator(baseDecimals, quoteDecimals);
        uint256 rawQuantity = (denominator + priceX18 - 1) / priceX18;
        if (rawQuantity > type(uint128).max) return type(uint128).max;
        return uint128(rawQuantity);
    }

    function quoteDenominator(uint8 baseDecimals, uint8 quoteDecimals)
        internal
        pure
        returns (uint256)
    {
        uint256 combinedDecimals = uint256(PRICE_DECIMALS) + baseDecimals;
        if (quoteDecimals > combinedDecimals) {
            revert UnsupportedDecimalRelationship(baseDecimals, quoteDecimals);
        }
        uint256 exponent = combinedDecimals - quoteDecimals;
        if (exponent > 77) revert UnsupportedDecimalRelationship(baseDecimals, quoteDecimals);
        return 10 ** exponent;
    }
}
