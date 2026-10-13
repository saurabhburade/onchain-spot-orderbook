// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Full-precision multiplication followed by division, rounded down.
/// @dev The implementation uses the standard 512-bit product decomposition popularized by
/// Uniswap FullMath and OpenZeppelin Math.
library FullMath {
    error MulDivOverflow();

    function mulDiv(uint256 x, uint256 y, uint256 denominator)
        internal
        pure
        returns (uint256 result)
    {
        unchecked {
            uint256 productLow;
            uint256 productHigh;
            assembly ("memory-safe") {
                let mm := mulmod(x, y, not(0))
                productLow := mul(x, y)
                productHigh := sub(sub(mm, productLow), lt(mm, productLow))
            }

            if (productHigh == 0) return productLow / denominator;
            if (denominator <= productHigh) revert MulDivOverflow();

            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(x, y, denominator)
                productHigh := sub(productHigh, gt(remainder, productLow))
                productLow := sub(productLow, remainder)
            }

            uint256 denominatorPowerOfTwo = denominator & (0 - denominator);
            assembly ("memory-safe") {
                denominator := div(denominator, denominatorPowerOfTwo)
                productLow := div(productLow, denominatorPowerOfTwo)
                denominatorPowerOfTwo := add(
                    div(sub(0, denominatorPowerOfTwo), denominatorPowerOfTwo),
                    1
                )
            }
            productLow |= productHigh * denominatorPowerOfTwo;

            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;

            result = productLow * inverse;
        }
    }
}
