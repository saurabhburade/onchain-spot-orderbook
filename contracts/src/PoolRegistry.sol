// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotCLOBFactory } from "./SpotCLOBFactory.sol";

/// @notice Backwards-compatible deployment name for the spot CLOB factory/registry.
/// @dev New integrations should use SpotCLOBFactory directly.
contract PoolRegistry is SpotCLOBFactory { }
