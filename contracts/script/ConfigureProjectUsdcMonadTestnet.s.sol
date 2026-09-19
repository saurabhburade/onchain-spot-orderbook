// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";

/// @dev Minimal Foundry cheatcode interface so this package has no script dependency.
interface ConfigureProjectUsdcVm {
    function addr(uint256 privateKey) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function getChainId() external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Allowlists the project USDC on the existing Monad Testnet factory and creates the
/// DUMMY1/project-USDC market. Safe to rerun after the market has been created.
contract ConfigureProjectUsdcMonadTestnet {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10_143;
    address internal constant SPOT_CLOB_FACTORY = 0x50fcEa11c0F01F0eeAa5E980dc4ae9977559330b;
    address internal constant DUMMY1 = 0x891874554c69A1006914a8fe6b733304E73CBDb5;
    address internal constant PROJECT_USDC = 0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3;
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    ConfigureProjectUsdcVm internal constant vm = ConfigureProjectUsdcVm(VM_ADDRESS);

    event log_named_address(string key, address value);
    event log_named_bytes32(string key, bytes32 value);

    function run() external returns (bytes32 poolId, address book) {
        require(
            vm.getChainId() == MONAD_TESTNET_CHAIN_ID,
            "ConfigureProjectUsdcMonadTestnet: use Monad Testnet chain id 10143"
        );

        uint256 ownerPrivateKey = vm.envUint("PRIVATE_KEY");
        SpotCLOBFactory factory = SpotCLOBFactory(SPOT_CLOB_FACTORY);
        require(
            factory.owner() == vm.addr(ownerPrivateKey),
            "ConfigureProjectUsdcMonadTestnet: PRIVATE_KEY is not the factory owner"
        );

        poolId = factory.pairId(DUMMY1, PROJECT_USDC);
        book = factory.getPair(poolId);

        vm.startBroadcast(ownerPrivateKey);
        if (!factory.isQuoteToken(PROJECT_USDC)) factory.setQuoteToken(PROJECT_USDC, true);
        if (book == address(0)) {
            factory.setPairLotDecimals(DUMMY1, PROJECT_USDC, 5);
            (poolId, book) = factory.createPair(DUMMY1, PROJECT_USDC, 1, 1, type(uint24).max);
        }
        vm.stopBroadcast();

        emit log_named_address("SpotCLOBFactory", SPOT_CLOB_FACTORY);
        emit log_named_address("DUMMY1", DUMMY1);
        emit log_named_address("USDC", PROJECT_USDC);
        emit log_named_bytes32("poolId", poolId);
        emit log_named_address("SpotCLOB", book);
    }
}
