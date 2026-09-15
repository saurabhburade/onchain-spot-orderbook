// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A sparse, three-level bitmap over the complete uint24 tick domain.
/// @dev Leaf words contain price ticks, middle words summarize non-empty leaf words, and root
/// summarizes non-empty middle words. Finding either extreme therefore requires three word reads.
library PriceBitmap {
    error TickAlreadySet(uint24 tick);
    error TickNotSet(uint24 tick);

    struct Data {
        mapping(uint16 leafIndex => uint256 word) leaf;
        mapping(uint8 group => uint256 word) middle;
        uint256 root;
    }

    function set(Data storage self, uint24 tick) internal {
        uint16 leafIndex = uint16(tick >> 8);
        uint8 group = uint8(leafIndex >> 8);
        uint256 leafMask = uint256(1) << uint8(tick);
        uint256 oldLeaf = self.leaf[leafIndex];

        if (oldLeaf & leafMask != 0) revert TickAlreadySet(tick);

        self.leaf[leafIndex] = oldLeaf | leafMask;
        if (oldLeaf != 0) return;

        uint256 middleMask = uint256(1) << uint8(leafIndex);
        uint256 oldMiddle = self.middle[group];
        self.middle[group] = oldMiddle | middleMask;
        if (oldMiddle == 0) self.root |= uint256(1) << group;
    }

    function clear(Data storage self, uint24 tick) internal {
        uint16 leafIndex = uint16(tick >> 8);
        uint8 group = uint8(leafIndex >> 8);
        uint256 leafMask = uint256(1) << uint8(tick);
        uint256 oldLeaf = self.leaf[leafIndex];

        if (oldLeaf & leafMask == 0) revert TickNotSet(tick);

        uint256 newLeaf = oldLeaf & ~leafMask;
        self.leaf[leafIndex] = newLeaf;
        if (newLeaf != 0) return;

        uint256 middleMask = uint256(1) << uint8(leafIndex);
        uint256 newMiddle = self.middle[group] & ~middleMask;
        self.middle[group] = newMiddle;
        if (newMiddle == 0) self.root &= ~(uint256(1) << group);
    }

    function contains(Data storage self, uint24 tick) internal view returns (bool) {
        uint16 leafIndex = uint16(tick >> 8);
        return self.leaf[leafIndex] & (uint256(1) << uint8(tick)) != 0;
    }

    function min(Data storage self) internal view returns (bool exists, uint24 tick) {
        uint256 rootWord = self.root;
        if (rootWord == 0) return (false, 0);

        uint8 group = leastSignificantBit(rootWord);
        uint8 leafOffset = leastSignificantBit(self.middle[group]);
        uint16 leafIndex = (uint16(group) << 8) | uint16(leafOffset);
        uint8 tickOffset = leastSignificantBit(self.leaf[leafIndex]);
        return (true, (uint24(leafIndex) << 8) | uint24(tickOffset));
    }

    function max(Data storage self) internal view returns (bool exists, uint24 tick) {
        uint256 rootWord = self.root;
        if (rootWord == 0) return (false, 0);

        uint8 group = mostSignificantBit(rootWord);
        uint8 leafOffset = mostSignificantBit(self.middle[group]);
        uint16 leafIndex = (uint16(group) << 8) | uint16(leafOffset);
        uint8 tickOffset = mostSignificantBit(self.leaf[leafIndex]);
        return (true, (uint24(leafIndex) << 8) | uint24(tickOffset));
    }

    /// @notice Return the lowest populated tick strictly greater than `tick`.
    function next(Data storage self, uint24 tick)
        internal
        view
        returns (bool exists, uint24 nextTick)
    {
        uint16 leafIndex = uint16(tick >> 8);
        uint8 tickOffset = uint8(tick);

        if (tickOffset != type(uint8).max) {
            uint256 leafWord = self.leaf[leafIndex] & (type(uint256).max << (tickOffset + 1));
            if (leafWord != 0) {
                return (true, (uint24(leafIndex) << 8) | uint24(leastSignificantBit(leafWord)));
            }
        }

        uint8 group = uint8(leafIndex >> 8);
        uint8 leafOffset = uint8(leafIndex);
        if (leafOffset != type(uint8).max) {
            uint256 middleWord = self.middle[group] & (type(uint256).max << (leafOffset + 1));
            if (middleWord != 0) {
                uint16 nextLeafIndex =
                    (uint16(group) << 8) | uint16(leastSignificantBit(middleWord));
                return _minimumInLeaf(self, nextLeafIndex);
            }
        }

        if (group == type(uint8).max) return (false, 0);
        uint256 rootWord = self.root & (type(uint256).max << (group + 1));
        if (rootWord == 0) return (false, 0);

        uint8 nextGroup = leastSignificantBit(rootWord);
        uint16 nextLeaf =
            (uint16(nextGroup) << 8) | uint16(leastSignificantBit(self.middle[nextGroup]));
        return _minimumInLeaf(self, nextLeaf);
    }

    /// @notice Return the highest populated tick strictly less than `tick`.
    function previous(Data storage self, uint24 tick)
        internal
        view
        returns (bool exists, uint24 previousTick)
    {
        uint16 leafIndex = uint16(tick >> 8);
        uint8 tickOffset = uint8(tick);

        if (tickOffset != 0) {
            uint256 leafWord = self.leaf[leafIndex] & (type(uint256).max >> (256 - tickOffset));
            if (leafWord != 0) {
                return (true, (uint24(leafIndex) << 8) | uint24(mostSignificantBit(leafWord)));
            }
        }

        uint8 group = uint8(leafIndex >> 8);
        uint8 leafOffset = uint8(leafIndex);
        if (leafOffset != 0) {
            uint256 middleWord = self.middle[group] & (type(uint256).max >> (256 - leafOffset));
            if (middleWord != 0) {
                uint16 previousLeafIndex =
                    (uint16(group) << 8) | uint16(mostSignificantBit(middleWord));
                return _maximumInLeaf(self, previousLeafIndex);
            }
        }

        if (group == 0) return (false, 0);
        uint256 rootWord = self.root & (type(uint256).max >> (256 - group));
        if (rootWord == 0) return (false, 0);

        uint8 previousGroup = mostSignificantBit(rootWord);
        uint16 previousLeaf =
            (uint16(previousGroup) << 8) | uint16(mostSignificantBit(self.middle[previousGroup]));
        return _maximumInLeaf(self, previousLeaf);
    }

    function _minimumInLeaf(Data storage self, uint16 leafIndex)
        private
        view
        returns (bool exists, uint24 tick)
    {
        return (true, (uint24(leafIndex) << 8) | uint24(leastSignificantBit(self.leaf[leafIndex])));
    }

    function _maximumInLeaf(Data storage self, uint16 leafIndex)
        private
        view
        returns (bool exists, uint24 tick)
    {
        return (true, (uint24(leafIndex) << 8) | uint24(mostSignificantBit(self.leaf[leafIndex])));
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
