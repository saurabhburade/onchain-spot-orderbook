// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotPriceMath } from "../src/libraries/SpotPriceMath.sol";

contract SpotPriceMathHarness {
    function minimumQuoteAmount(uint8 quoteDecimals) external pure returns (uint256) {
        return SpotPriceMath.minimumQuoteAmount(quoteDecimals);
    }

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
        _assertMinimum(1e7, 10_000_000_000e18); // 0.00000000001 USDC/token.
        _assertMinimum(1e12, 100_000e18); // 0.000001 USDC/token.
        _assertMinimum(1e18, 1e17); // 1 USDC/token.
        _assertMinimum(10e18, 1e16); // 10 USDC/token.
        _assertMinimum(1e24, 1e11); // 1,000,000 USDC/token.
    }

    function testMinimumQuoteAmountIsOneTenthOfToken() public view {
        require(math.minimumQuoteAmount(6) == 100_000, "wrong USDC floor");
        require(math.minimumQuoteAmount(18) == 1e17, "wrong 18-decimal floor");
        require(math.minimumQuoteAmount(0) == 1, "zero-decimal floor is not one atom");
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

    function testFuzz_MinimumQuantityIsMinimalOrSaturated(uint128 price, uint8 exponentSeed)
        public
        view
    {
        if (price == 0) price = 1;
        uint8 exponent = exponentSeed % 78;
        // Choose decimals that exercise every supported denominator, including 10**77.
        uint8 baseDecimals = exponent >= 18 ? exponent - 18 : 0;
        uint8 quoteDecimals = exponent >= 18 ? 0 : 18 - exponent;
        uint128 quantity = math.minimumBaseQuantity(price, baseDecimals, quoteDecimals);
        uint256 target = math.minimumQuoteAmount(quoteDecimals);
        if (math.quoteAmount(price, type(uint128).max, baseDecimals, quoteDecimals) < target) {
            require(quantity == type(uint128).max, "unreachable minimum was not saturated");
        } else {
            require(
                math.quoteAmount(price, quantity, baseDecimals, quoteDecimals) >= target,
                "minimum cannot settle"
            );
            require(
                math.quoteAmount(price, quantity - 1, baseDecimals, quoteDecimals) < target,
                "minimum is not minimal"
            );
        }
    }

    function testFuzz_QuoteRoundingAcrossDecimals(
        uint128 price,
        uint128 quantity,
        uint8 exponentSeed
    ) public view {
        uint8 exponent = exponentSeed % 78;
        uint8 baseDecimals = exponent >= 18 ? exponent - 18 : 0;
        uint8 quoteDecimals = exponent >= 18 ? 0 : 18 - exponent;
        uint256 denominator = 10 ** uint256(exponent);
        uint256 product = uint256(price) * quantity;
        uint256 settled = math.quoteAmount(price, quantity, baseDecimals, quoteDecimals);
        require(settled * denominator <= product, "quote rounded up");
        require(product - settled * denominator < denominator, "quote lost a whole atom");

        uint128 first = quantity / 2;
        uint256 split = math.quoteAmount(price, first, baseDecimals, quoteDecimals)
            + math.quoteAmount(price, quantity - first, baseDecimals, quoteDecimals);
        require(settled >= split && settled - split <= 1, "split rounding exceeds one atom");
    }

    function testFuzz_RejectsUnsupportedDecimalRelationships(uint8 seed, bool excessiveExponent)
        public
        view
    {
        uint8 baseDecimals = excessiveExponent ? uint8(60 + seed % 196) : uint8(seed % 237);
        uint8 quoteDecimals = excessiveExponent ? 0 : baseDecimals + 19;
        (bool success, bytes memory reason) = address(math)
            .staticcall(
                abi.encodeCall(
                    SpotPriceMathHarness.quoteAmount, (1, 1, baseDecimals, quoteDecimals)
                )
            );
        require(!success, "unsupported decimals accepted");
        require(
            keccak256(reason)
                == keccak256(
                    abi.encodeWithSelector(
                        SpotPriceMath.UnsupportedDecimalRelationship.selector,
                        baseDecimals,
                        quoteDecimals
                    )
                ),
            "wrong decimal rejection"
        );
    }

    function testZeroPriceHasNoMinimum() public view {
        require(math.minimumBaseQuantity(0, 18, 6) == 0, "zero price has a minimum");
    }

    function _assertMinimum(uint128 priceX18, uint128 expectedQuantity) private view {
        uint128 quantity = math.minimumBaseQuantity(priceX18, 18, 6);
        require(quantity == expectedQuantity, "minimum quantity changed");
        require(math.quoteAmount(priceX18, quantity, 18, 6) == 100_000, "minimum is not 0.1 USDC");
        if (quantity > 1) {
            require(
                math.quoteAmount(priceX18, quantity - 1, 18, 6) < 100_000,
                "smaller quantity meets admission floor"
            );
        }
    }
}
