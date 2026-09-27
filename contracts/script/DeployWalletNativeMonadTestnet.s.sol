// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

/// @dev Minimal Foundry cheatcode interface so this package has no script dependency.
interface WalletNativeMonadVm {
    function getChainId() external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploy the current CLOB factory, lens, and USDC-quoted Monad Testnet markets.
contract DeployWalletNativeMonadTestnet {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10_143;
    address internal constant DUMMY1 = 0x891874554c69A1006914a8fe6b733304E73CBDb5;
    address internal constant USDT = 0xef271f6433E05757A94e28873911Af92f0D0b9f3;
    address internal constant MON = 0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541;
    address internal constant PROJECT_USDC = 0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3;
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    WalletNativeMonadVm internal constant vm = WalletNativeMonadVm(VM_ADDRESS);

    event log_named_address(string key, address value);
    event log_named_bytes32(string key, bytes32 value);
    event log_named_uint(string key, uint256 value);

    function run() external returns (address factory, address book, address lens, bytes32 pairId) {
        require(
            vm.getChainId() == MONAD_TESTNET_CHAIN_ID,
            "DeployWalletNativeMonadTestnet: use Monad Testnet chain id 10143"
        );

        vm.startBroadcast();
        SpotCLOBFactory deployedFactory = new SpotCLOBFactory();
        SpotCLOBLens deployedLens = new SpotCLOBLens();
        deployedFactory.setQuoteToken(PROJECT_USDC, true);
        (pairId, book) = deployedFactory.createPair(DUMMY1, PROJECT_USDC);
        (bytes32 stablePairId, address stableBook) = deployedFactory.createPair(USDT, PROJECT_USDC);
        (bytes32 monPairId, address monBook) = deployedFactory.createPair(MON, PROJECT_USDC);
        vm.stopBroadcast();

        factory = address(deployedFactory);
        lens = address(deployedLens);
        emit log_named_address("SpotCLOBFactory", factory);
        emit log_named_address("SpotCLOB", book);
        emit log_named_address("SpotCLOBLens", lens);
        emit log_named_bytes32("DUMMY1_USDC_PAIR_ID", pairId);
        emit log_named_address("DUMMY1_USDC_BOOK", book);
        emit log_named_bytes32("USDT_USDC_PAIR_ID", stablePairId);
        emit log_named_address("USDT_USDC_BOOK", stableBook);
        emit log_named_bytes32("MON_USDC_PAIR_ID", monPairId);
        emit log_named_address("MON_USDC_BOOK", monBook);
        emit log_named_uint("minimumPriceX18", 1);
        emit log_named_uint("maximumPriceX18", type(uint128).max);
        emit log_named_uint("chainId", MONAD_TESTNET_CHAIN_ID);
    }
}
