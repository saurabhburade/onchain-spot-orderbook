// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Reserve-backed faucet for one or more ERC-20 test tokens.
/// @dev Fund this contract by transferring configured tokens to it. Claim amounts use the token's
/// smallest unit; for a six-decimal token, 10,000 tokens is configured as `10_000e6`.
contract TokenFaucet {
    error Unauthorized();
    error InvalidToken();
    error InvalidClaimAmount();
    error TokenNotConfigured(address token);
    error ClaimCoolingDown(address account, address token, uint256 nextClaimAt);
    error TokenTransferFailed();

    struct TokenConfig {
        uint256 claimAmount;
        uint256 cooldown;
        bool enabled;
    }

    address public immutable owner;

    mapping(address token => TokenConfig config) public tokenConfig;
    mapping(address account => mapping(address token => uint256 timestamp)) public nextClaimAt;

    event TokenConfigured(
        address indexed token, uint256 claimAmount, uint256 cooldown, bool enabled
    );
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Enable or update a token that users may claim.
    /// @param token ERC-20 token address. The contract must be funded separately.
    /// @param claimAmount Amount paid per claim, expressed in the token's smallest unit.
    /// @param cooldown Seconds an account must wait between claims of this token.
    function configureToken(address token, uint256 claimAmount, uint256 cooldown)
        external
        onlyOwner
    {
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (claimAmount == 0) revert InvalidClaimAmount();

        tokenConfig[token] =
            TokenConfig({ claimAmount: claimAmount, cooldown: cooldown, enabled: true });
        emit TokenConfigured(token, claimAmount, cooldown, true);
    }

    /// @notice Stop future claims for a token without changing its saved amount or cooldown.
    function disableToken(address token) external onlyOwner {
        TokenConfig storage config = tokenConfig[token];
        if (!config.enabled) revert TokenNotConfigured(token);

        config.enabled = false;
        emit TokenConfigured(token, config.claimAmount, config.cooldown, false);
    }

    /// @notice Claim the configured amount of `token` for the caller.
    function claim(address token) external {
        TokenConfig memory config = tokenConfig[token];
        if (!config.enabled) revert TokenNotConfigured(token);

        uint256 availableAt = nextClaimAt[msg.sender][token];
        if (block.timestamp < availableAt) {
            revert ClaimCoolingDown(msg.sender, token, availableAt);
        }

        nextClaimAt[msg.sender][token] = block.timestamp + config.cooldown;
        _safeTransfer(token, msg.sender, config.claimAmount);
        emit Claimed(msg.sender, token, config.claimAmount);
    }

    /// @notice Recover reserves or tokens accidentally sent to the faucet.
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidToken();
        _safeTransfer(token, to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory result) =
            token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
