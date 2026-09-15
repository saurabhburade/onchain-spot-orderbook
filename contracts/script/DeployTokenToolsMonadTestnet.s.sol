// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20TokenFactory } from "../src/ERC20TokenFactory.sol";
import { MintableERC20 } from "../src/MintableERC20.sol";
import { TokenFaucet } from "../src/TokenFaucet.sol";

/// @dev Minimal Foundry cheatcode interface so this package has no script dependency.
interface TokenToolsVm {
    function envUint(string calldata name) external returns (uint256);
    function getChainId() external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploy the token factory and a funded USDC/USDT faucet to Monad Testnet.
contract DeployTokenToolsMonadTestnet {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10_143;
    uint256 internal constant CLAIM_AMOUNT = 10_000e6;
    uint256 internal constant CLAIM_COOLDOWN = 1 days;
    uint256 internal constant FAUCET_RESERVE = 10_000_000e6;
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    TokenToolsVm internal constant vm = TokenToolsVm(VM_ADDRESS);

    event log_named_address(string key, address value);
    event log_named_uint(string key, uint256 value);

    function run() external returns (address factory, address faucet, address usdc, address usdt) {
        require(
            vm.getChainId() == MONAD_TESTNET_CHAIN_ID,
            "DeployTokenToolsMonadTestnet: use Monad Testnet chain id 10143"
        );

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        ERC20TokenFactory deployedFactory = new ERC20TokenFactory();
        TokenFaucet deployedFaucet = new TokenFaucet();
        MintableERC20 deployedUsdc =
            MintableERC20(deployedFactory.createToken("USD Coin", "USDC", 6, FAUCET_RESERVE));
        MintableERC20 deployedUsdt =
            MintableERC20(deployedFactory.createToken("Tether USD", "USDT", 6, FAUCET_RESERVE));

        deployedFaucet.configureToken(address(deployedUsdc), CLAIM_AMOUNT, CLAIM_COOLDOWN);
        deployedFaucet.configureToken(address(deployedUsdt), CLAIM_AMOUNT, CLAIM_COOLDOWN);
        require(
            deployedUsdc.transfer(address(deployedFaucet), FAUCET_RESERVE),
            "USDC faucet funding failed"
        );
        require(
            deployedUsdt.transfer(address(deployedFaucet), FAUCET_RESERVE),
            "USDT faucet funding failed"
        );

        vm.stopBroadcast();

        factory = address(deployedFactory);
        faucet = address(deployedFaucet);
        usdc = address(deployedUsdc);
        usdt = address(deployedUsdt);

        emit log_named_address("ERC20TokenFactory", factory);
        emit log_named_address("TokenFaucet", faucet);
        emit log_named_address("USDC", usdc);
        emit log_named_address("USDT", usdt);
        emit log_named_uint("claimAmount", CLAIM_AMOUNT);
        emit log_named_uint("claimCooldown", CLAIM_COOLDOWN);
        emit log_named_uint("reservePerToken", FAUCET_RESERVE);
        emit log_named_uint("chainId", MONAD_TESTNET_CHAIN_ID);
    }
}
