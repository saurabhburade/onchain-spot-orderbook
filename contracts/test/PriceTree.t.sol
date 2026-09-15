// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PriceTree } from "../src/libraries/PriceTree.sol";

contract PriceTreeHarness {
    using PriceTree for PriceTree.Data;

    PriceTree.Data private _tree;

    function set(uint128 price) external {
        _tree.set(price);
    }

    function clear(uint128 price) external {
        _tree.clear(price);
    }

    function contains(uint128 price) external view returns (bool) {
        return _tree.contains(price);
    }

    function min() external view returns (bool, uint128) {
        return _tree.min();
    }

    function max() external view returns (bool, uint128) {
        return _tree.max();
    }

    function next(uint128 price) external view returns (bool, uint128) {
        return _tree.next(price);
    }

    function previous(uint128 price) external view returns (bool, uint128) {
        return _tree.previous(price);
    }
}

contract PriceTreeTest {
    PriceTreeHarness private tree;

    function setUp() public {
        tree = new PriceTreeHarness();
    }

    function testTraversesEntireUint128PriceDomain() public {
        uint128[] memory prices = new uint128[](7);
        prices[0] = 1;
        prices[1] = 1e7; // 0.00000000001 at 18-decimal price precision.
        prices[2] = 1e18; // 1 quote token.
        prices[3] = uint128(1) << 64;
        prices[4] = 1e24; // 1,000,000 quote tokens.
        prices[5] = type(uint128).max - 1;
        prices[6] = type(uint128).max;

        for (uint256 i; i < prices.length; ++i) {
            tree.set(prices[i]);
        }

        (bool minExists, uint128 minimum) = tree.min();
        (bool maxExists, uint128 maximum) = tree.max();
        require(minExists && minimum == prices[0], "wrong minimum");
        require(maxExists && maximum == prices[6], "wrong maximum");

        for (uint256 i; i < prices.length; ++i) {
            require(tree.contains(prices[i]), "inserted price missing");
            if (i + 1 < prices.length) {
                (bool nextExists, uint128 nextPrice) = tree.next(prices[i]);
                require(nextExists && nextPrice == prices[i + 1], "wrong successor");
            }
            if (i != 0) {
                (bool previousExists, uint128 previousPrice) = tree.previous(prices[i]);
                require(previousExists && previousPrice == prices[i - 1], "wrong predecessor");
            }
        }
    }

    function testClearCascadesOnlyThroughEmptyPrefixes() public {
        uint128 low = 1e7;
        uint128 adjacent = low + 1;
        uint128 high = 1e24;
        tree.set(low);
        tree.set(adjacent);
        tree.set(high);

        tree.clear(low);
        require(!tree.contains(low) && tree.contains(adjacent), "shared prefix was corrupted");
        (bool minExists, uint128 minimum) = tree.min();
        require(minExists && minimum == adjacent, "wrong minimum after first clear");

        tree.clear(adjacent);
        (minExists, minimum) = tree.min();
        require(minExists && minimum == high, "prefix did not cascade");

        tree.clear(high);
        (minExists,) = tree.min();
        require(!minExists, "tree was not emptied");
    }

    function testRejectsDuplicateSetAndMissingClear() public {
        tree.set(42);
        (bool duplicate,) = address(tree).call(abi.encodeCall(PriceTreeHarness.set, (uint128(42))));
        require(!duplicate, "duplicate price succeeded");

        (bool missing,) = address(tree).call(abi.encodeCall(PriceTreeHarness.clear, (uint128(43))));
        require(!missing, "missing price clear succeeded");
    }
}
