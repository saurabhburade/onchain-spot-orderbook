// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotPriceMath } from "../src/libraries/SpotPriceMath.sol";

contract SpotPriceMathHarness {
    function quoteAmount(
        uint128 priceX18,
        uint128 baseQuantity,
        uint8 baseDecimals,
        uint8 quoteDecimals
    ) external pure returns (uint256) {
        return SpotPriceMath.quoteAmount(priceX18, baseQuantity, baseDecimals, quoteDecimals);
    }

    function minimumBaseQuantity(uint128 priceX18, uint8 baseDecimals, uint8 quoteDecimals)
        external
        pure
        returns (uint128)
    {
        return SpotPriceMath.minimumBaseQuantity(priceX18, baseDecimals, quoteDecimals);
    }
}

contract SpotPriceMathTest {
    SpotPriceMathHarness private math;

    function setUp() public {
        math = new SpotPriceMathHarness();
    }

    function testSupplyAgnosticMinimumQuantityRegression() public view {
        _assertMinimum(1e7, 100_000e18); // 0.00000000001 USDC/token.
        _assertMinimum(1e12, 1e18); // 0.000001 USDC/token.
        _assertMinimum(1e18, 1e12); // 1 USDC/token.
        _assertMinimum(10e18, 1e11); // 10 USDC/token.
        _assertMinimum(1e24, 1e6); // 1,000,000 USDC/token.
    }

    function testTrillionTokenSupplyDoesNotLimitPriceRepresentation() public view {
        uint128 trillionTokens = uint128(1_000_000_000_000e18);
        uint256 quoteAtoms = math.quoteAmount(1e7, trillionTokens, 18, 6);
        require(quoteAtoms == 10e6, "trillion-token quote changed");
    }

    function testOneHundredTokenSupplyCanBePricedAtOneMillionUsdc() public view {
        uint128 oneHundredTokens = uint128(100e18);
        uint256 quoteAtoms = math.quoteAmount(1e24, oneHundredTokens, 18, 6);
        require(quoteAtoms == 100_000_000e6, "scarce-token quote changed");
    }

    function _assertMinimum(uint128 priceX18, uint128 expectedQuantity) private view {
        uint128 quantity = math.minimumBaseQuantity(priceX18, 18, 6);
        require(quantity == expectedQuantity, "minimum quantity changed");
        require(math.quoteAmount(priceX18, quantity, 18, 6) == 1, "minimum is not one atom");
        if (quantity > 1) {
            require(
                math.quoteAmount(priceX18, quantity - 1, 18, 6) == 0,
                "smaller quantity unexpectedly settles"
            );
        }
    }
}
