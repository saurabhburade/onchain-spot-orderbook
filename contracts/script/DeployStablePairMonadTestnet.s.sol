// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SpotCLOBFactory } from "../src/SpotCLOBFactory.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";

interface StablePairMonadVm {
    function envUint(string calldata name) external returns (uint256);
    function getChainId() external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Deploy the precision-price CLOB and its faucet-backed USDT/USDC market.
contract DeployStablePairMonadTestnet {
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10_143;
    address internal constant USDC = 0xa3bCAfb554fe87109b92B3655c7Cf36Ba5C46aF3;
    address internal constant USDT = 0xef271f6433E05757A94e28873911Af92f0D0b9f3;
    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    StablePairMonadVm internal constant vm = StablePairMonadVm(VM_ADDRESS);

    event log_named_address(string key, address value);
    event log_named_bytes32(string key, bytes32 value);

    function run() external returns (address factory, address book, address lens, bytes32 pairId) {
        require(
            vm.getChainId() == MONAD_TESTNET_CHAIN_ID,
            "DeployStablePairMonadTestnet: use Monad Testnet chain id 10143"
        );

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        SpotCLOBFactory deployedFactory = new SpotCLOBFactory();
        SpotCLOBLens deployedLens = new SpotCLOBLens();
        deployedFactory.setQuoteToken(USDC, true);
        (pairId, book) = deployedFactory.createPair(USDT, USDC);
        vm.stopBroadcast();

        factory = address(deployedFactory);
        lens = address(deployedLens);
        emit log_named_address("SpotCLOBFactory", factory);
        emit log_named_address("SpotCLOB", book);
        emit log_named_address("SpotCLOBLens", lens);
        emit log_named_bytes32("USDT_USDC_PAIR_ID", pairId);
    }
}
