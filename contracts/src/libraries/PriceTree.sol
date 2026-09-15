// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Sparse radix tree over the complete uint128 price domain.
/// @dev Every node is a 256-bit child bitmap. A lookup touches at most sixteen nodes, so price
/// discovery is bounded independently of the distance between populated prices.
library PriceTree {
    error PriceAlreadySet(uint128 price);
    error PriceNotSet(uint128 price);

    uint8 private constant _DEPTH = 16;

    struct Data {
        mapping(uint8 depth => mapping(uint128 prefix => uint256 children)) nodes;
    }

    function set(Data storage self, uint128 price) internal {
        if (contains(self, price)) revert PriceAlreadySet(price);

        for (uint8 depth; depth < _DEPTH; ++depth) {
            uint128 prefix = _prefix(price, depth);
            uint256 mask = uint256(1) << _byteAt(price, depth);
            self.nodes[depth][prefix] |= mask;
        }
    }

    function clear(Data storage self, uint128 price) internal {
        if (!contains(self, price)) revert PriceNotSet(price);

        for (uint256 cursor = _DEPTH; cursor != 0; --cursor) {
            uint8 depth = uint8(cursor - 1);
            uint128 prefix = _prefix(price, depth);
            uint256 newWord = self.nodes[depth][prefix] & ~(uint256(1) << _byteAt(price, depth));
            self.nodes[depth][prefix] = newWord;
            if (newWord != 0) break;
        }
    }

    function contains(Data storage self, uint128 price) internal view returns (bool) {
        uint256 word = self.nodes[_DEPTH - 1][price >> 8];
        return word & (uint256(1) << uint8(price)) != 0;
    }

    function min(Data storage self) internal view returns (bool exists, uint128 price) {
        uint256 root = self.nodes[0][0];
        if (root == 0) return (false, 0);
        return (true, _descendMinimum(self, 0, 0));
    }

    function max(Data storage self) internal view returns (bool exists, uint128 price) {
        uint256 root = self.nodes[0][0];
        if (root == 0) return (false, 0);
        return (true, _descendMaximum(self, 0, 0));
    }

    /// @notice Return the lowest populated price strictly greater than `price`.
    function next(Data storage self, uint128 price)
        internal
        view
        returns (bool exists, uint128 nextPrice)
    {
        for (uint256 cursor = _DEPTH; cursor != 0; --cursor) {
            uint8 depth = uint8(cursor - 1);
            uint8 current = _byteAt(price, depth);
            if (current == type(uint8).max) continue;

            uint128 prefix = _prefix(price, depth);
            uint256 candidates =
                self.nodes[depth][prefix] & (type(uint256).max << (uint256(current) + 1));
            if (candidates == 0) continue;

            uint8 child = leastSignificantBit(candidates);
            return (true, _descendMinimum(self, depth + 1, (prefix << 8) | child));
        }
        return (false, 0);
    }

    /// @notice Return the highest populated price strictly less than `price`.
    function previous(Data storage self, uint128 price)
        internal
        view
        returns (bool exists, uint128 previousPrice)
    {
        for (uint256 cursor = _DEPTH; cursor != 0; --cursor) {
            uint8 depth = uint8(cursor - 1);
            uint8 current = _byteAt(price, depth);
            if (current == 0) continue;

            uint128 prefix = _prefix(price, depth);
            uint256 candidates =
                self.nodes[depth][prefix] & (type(uint256).max >> (256 - uint256(current)));
            if (candidates == 0) continue;

            uint8 child = mostSignificantBit(candidates);
            return (true, _descendMaximum(self, depth + 1, (prefix << 8) | child));
        }
        return (false, 0);
    }

    function _descendMinimum(Data storage self, uint8 depth, uint128 prefix)
        private
        view
        returns (uint128 price)
    {
        price = prefix;
        for (uint8 cursor = depth; cursor < _DEPTH; ++cursor) {
            uint8 child = leastSignificantBit(self.nodes[cursor][price]);
            price = (price << 8) | child;
        }
    }

    function _descendMaximum(Data storage self, uint8 depth, uint128 prefix)
        private
        view
        returns (uint128 price)
    {
        price = prefix;
        for (uint8 cursor = depth; cursor < _DEPTH; ++cursor) {
            uint8 child = mostSignificantBit(self.nodes[cursor][price]);
            price = (price << 8) | child;
        }
    }

    function _prefix(uint128 price, uint8 depth) private pure returns (uint128) {
        if (depth == 0) return 0;
        return price >> (uint256(_DEPTH - depth) * 8);
    }

    function _byteAt(uint128 price, uint8 depth) private pure returns (uint8) {
        return uint8(price >> (uint256(_DEPTH - 1 - depth) * 8));
    }

    function leastSignificantBit(uint256 value) internal pure returns (uint8 result) {
        // Callers only pass non-zero words.
        if (value & type(uint128).max == 0) {
            value >>= 128;
            result += 128;
        }
        if (value & type(uint64).max == 0) {
            value >>= 64;
            result += 64;
        }
        if (value & type(uint32).max == 0) {
            value >>= 32;
            result += 32;
        }
        if (value & type(uint16).max == 0) {
            value >>= 16;
            result += 16;
        }
        if (value & type(uint8).max == 0) {
            value >>= 8;
            result += 8;
        }
        if (value & 0x0f == 0) {
            value >>= 4;
            result += 4;
        }
        if (value & 0x03 == 0) {
            value >>= 2;
            result += 2;
        }
        if (value & 0x01 == 0) result += 1;
    }

    function mostSignificantBit(uint256 value) internal pure returns (uint8 result) {
        // Callers only pass non-zero words.
        if (value >> 128 != 0) {
            value >>= 128;
            result += 128;
        }
        if (value >> 64 != 0) {
            value >>= 64;
            result += 64;
        }
        if (value >> 32 != 0) {
            value >>= 32;
            result += 32;
        }
        if (value >> 16 != 0) {
            value >>= 16;
            result += 16;
        }
        if (value >> 8 != 0) {
            value >>= 8;
            result += 8;
        }
        if (value >> 4 != 0) {
            value >>= 4;
            result += 4;
        }
        if (value >> 2 != 0) {
            value >>= 2;
            result += 2;
        }
        if (value >> 1 != 0) result += 1;
    }
}
