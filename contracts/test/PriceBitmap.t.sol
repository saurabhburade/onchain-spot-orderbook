// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PriceBitmap } from "../src/libraries/PriceBitmap.sol";

contract PriceBitmapHarness {
    using PriceBitmap for PriceBitmap.Data;

    PriceBitmap.Data private _bitmap;

    function set(uint24 tick) external {
        _bitmap.set(tick);
    }

    function clear(uint24 tick) external {
        _bitmap.clear(tick);
    }

    function contains(uint24 tick) external view returns (bool) {
        return _bitmap.contains(tick);
    }

    function min() external view returns (bool, uint24) {
        return _bitmap.min();
    }

    function max() external view returns (bool, uint24) {
        return _bitmap.max();
    }

    function next(uint24 tick) external view returns (bool, uint24) {
        return _bitmap.next(tick);
    }

    function previous(uint24 tick) external view returns (bool, uint24) {
        return _bitmap.previous(tick);
    }
}

contract PriceBitmapTest {
    PriceBitmapHarness private bitmap;

    function setUp() public {
        bitmap = new PriceBitmapHarness();
    }

    function testTraversesEveryHierarchyBoundaryInBothDirections() public {
        uint24[7] memory ticks = [
            uint24(0),
            uint24(1),
            uint24(255),
            uint24(256),
            uint24(65_535),
            uint24(65_536),
            type(uint24).max
        ];
        for (uint256 i; i < ticks.length; ++i) {
            bitmap.set(ticks[i]);
        }

        _assertMin(0);
        _assertMax(type(uint24).max);
        for (uint256 i; i + 1 < ticks.length; ++i) {
            (bool nextExists, uint24 nextTick) = bitmap.next(ticks[i]);
            (bool previousExists, uint24 previousTick) = bitmap.previous(ticks[i + 1]);
            _assertTick(nextExists, nextTick, ticks[i + 1]);
            _assertTick(previousExists, previousTick, ticks[i]);
        }

        (bool hasNext,) = bitmap.next(type(uint24).max);
        (bool hasPrevious,) = bitmap.previous(0);
        require(!hasNext && !hasPrevious, "extreme traversal should be empty");
    }

    function testClearCascadesThroughAllSummaryLevels() public {
        bitmap.set(1);
        bitmap.set(300);
        bitmap.set(70_000);

        bitmap.clear(1);
        _assertMin(300);
        bitmap.clear(300);
        _assertMin(70_000);
        bitmap.clear(70_000);

        (bool minExists,) = bitmap.min();
        (bool maxExists,) = bitmap.max();
        require(!minExists && !maxExists, "summary did not clear");
    }

    function testContainsAndRejectsDuplicateMutation() public {
        require(!bitmap.contains(42), "empty bitmap contained tick");
        bitmap.set(42);
        require(bitmap.contains(42), "set tick missing");

        (bool duplicateSet,) = address(bitmap).call(abi.encodeCall(PriceBitmapHarness.set, (42)));
        require(!duplicateSet, "duplicate set succeeded");
        bitmap.clear(42);
        require(!bitmap.contains(42), "cleared tick remained");

        (bool duplicateClear,) =
            address(bitmap).call(abi.encodeCall(PriceBitmapHarness.clear, (42)));
        require(!duplicateClear, "clearing absent tick succeeded");
    }

    function testPreviousReturnsEmptyWhenOnlyHigherRootGroupsExist() public {
        bitmap.set(2 << 16);
        (bool exists,) = bitmap.previous(1 << 16);
        require(!exists, "previous crossed into a higher group");
    }

    function _assertMin(uint24 expected) private view {
        (bool exists, uint24 actual) = bitmap.min();
        _assertTick(exists, actual, expected);
    }

    function _assertMax(uint24 expected) private view {
        (bool exists, uint24 actual) = bitmap.max();
        _assertTick(exists, actual, expected);
    }

    function _assertTick(bool exists, uint24 actual, uint24 expected) private pure {
        require(exists && actual == expected, "wrong bitmap tick");
    }
}
