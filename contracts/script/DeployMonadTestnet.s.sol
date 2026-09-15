// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

/// @dev Minimal Foundry cheatcode interface so this package has no script dependency.
interface MonadVm {
    function envUint(string calldata name) external returns (uint256);
    function getChainId() external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploy the CLOB factory to Monad Testnet and allowlist the project test USDC.
contract DeployMonadTestnet {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10_143;
    address internal constant PROJECT_TESTNET_USDC = 0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3;
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    MonadVm internal constant vm = MonadVm(VM_ADDRESS);

    event log_named_address(string key, address value);
    event log_named_uint(string key, uint256 value);

    function run() external returns (address factory) {
        require(
            vm.getChainId() == MONAD_TESTNET_CHAIN_ID,
            "DeployMonadTestnet: use Monad Testnet chain id 10143"
        );

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        SpotCLOBFactory deployedFactory = new SpotCLOBFactory();
        deployedFactory.setQuoteToken(PROJECT_TESTNET_USDC, true);
        vm.stopBroadcast();

        factory = address(deployedFactory);
        emit log_named_address("SpotCLOBFactory", factory);
        emit log_named_address("USDC", PROJECT_TESTNET_USDC);
        emit log_named_address("owner", deployedFactory.owner());
        emit log_named_uint("chainId", MONAD_TESTNET_CHAIN_ID);
    }
}
