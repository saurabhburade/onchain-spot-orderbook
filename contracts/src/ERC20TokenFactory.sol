// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MintableERC20 } from "./MintableERC20.sol";

/// @notice Permissionless factory for creator-owned mintable ERC-20 tokens.
contract ERC20TokenFactory {
    address[] private _allTokens;
    mapping(address creator => address[] tokens) private _tokensByCreator;

    event TokenCreated(
        address indexed creator,
        address indexed token,
        string name,
        string symbol,
        uint8 decimals,
        uint256 initialSupply
    );

    /// @notice Deploy a token owned by the caller and mint its initial supply to the caller.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply
    ) external returns (address token) {
        token = address(new MintableERC20(name, symbol, decimals, msg.sender, initialSupply));
        _allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);
        emit TokenCreated(msg.sender, token, name, symbol, decimals, initialSupply);
    }

    function allTokensLength() external view returns (uint256) {
        return _allTokens.length;
    }

    function tokenAt(uint256 index) external view returns (address) {
        return _allTokens[index];
    }

    function tokensByCreatorLength(address creator) external view returns (uint256) {
        return _tokensByCreator[creator].length;
    }

    function tokenByCreatorAt(address creator, uint256 index) external view returns (address) {
        return _tokensByCreator[creator][index];
    }
}
