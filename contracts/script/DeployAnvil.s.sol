// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20TokenFactory } from "../src/ERC20TokenFactory.sol";
import { IPoolRegistry } from "../src/IPoolRegistry.sol";
import { ISpotCLOB } from "../src/ISpotCLOB.sol";
import { PoolRegistry } from "../src/PoolRegistry.sol";
import { SpotCLOB } from "../src/SpotCLOB.sol";
import { SpotCLOBLens } from "../src/SpotCLOBLens.sol";
import { TokenFaucet } from "../src/TokenFaucet.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";

/// @dev Minimal Foundry cheatcode interface so this package has no script dependency.
interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function getChainId() external view returns (uint256);
}

/// @notice Deploy and seed the complete local market used by the web UI.
/// @dev This script is intentionally Anvil-only. Every key below is a public Anvil dev key.
contract DeployAnvil {
    struct Deployment {
        address mon;
        address usdc;
        address registry;
        address exchange;
        bytes32 poolId;
        address usdt;
        address faucet;
    }

    // DO NOT USE THESE KEYS OUTSIDE A FRESH LOCAL ANVIL INSTANCE.
    uint256 internal constant DEPLOYER_PRIVATE_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant SELLER_A_PRIVATE_KEY =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant SELLER_B_PRIVATE_KEY =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant BUYER_A_PRIVATE_KEY =
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 internal constant BUYER_B_PRIVATE_KEY =
        0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    address internal constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm internal constant vm = Vm(VM_ADDRESS);

    uint256 internal constant FAUCET_CLAIM_AMOUNT = 10_000e6;
    uint256 internal constant FAUCET_COOLDOWN = 1 days;
    uint256 internal constant FAUCET_RESERVE = 1_000_000e6;

    uint128 internal constant BID_PRICE_A = 0.428 ether;
    uint128 internal constant BID_PRICE_B = 0.427 ether;
    uint128 internal constant ASK_PRICE_A = 0.429 ether;
    uint128 internal constant ASK_PRICE_B = 0.43 ether;
    uint128 internal constant BID_QUANTITY_A = 3 ether;
    uint128 internal constant BID_QUANTITY_B = 2 ether;
    uint128 internal constant ASK_QUANTITY_A = 2 ether;
    uint128 internal constant ASK_QUANTITY_B = 3 ether;

    event log_string(string value);
    event log_named_address(string key, address value);
    event log_named_bytes32(string key, bytes32 value);
    event log_named_uint(string key, uint256 value);

    function run()
        external
        returns (address mon, address usdc, address registry, address exchange, bytes32 poolId)
    {
        require(vm.getChainId() == 31_337, "DeployAnvil: use Anvil chain id 31337");

        vm.startBroadcast(DEPLOYER_PRIVATE_KEY);
        Deployment memory deployed = _deployMarket();
        (deployed.usdt, deployed.faucet) = _deployTools(deployed.usdc);
        vm.stopBroadcast();

        mon = deployed.mon;
        usdc = deployed.usdc;
        registry = deployed.registry;
        exchange = deployed.exchange;
        poolId = deployed.poolId;

        _logDeployment(mon, usdc, registry, exchange, poolId);
        _logFaucet(deployed.usdt, deployed.faucet);
        _seedBalances(MockERC20(mon), MockERC20(usdc), SpotCLOB(exchange));
        _seedBook(MockERC20(mon), MockERC20(usdc), SpotCLOB(exchange));
        _logAndVerifyBook(SpotCLOB(exchange), poolId);
    }

    function _deployMarket() private returns (Deployment memory deployed) {
        MockERC20 deployedMon = new MockERC20("Monad", "MON", 18);
        MockERC20 deployedUsdc = new MockERC20("USD Coin", "USDC", 6);
        PoolRegistry deployedRegistry = new PoolRegistry();
        deployedRegistry.setQuoteToken(address(deployedUsdc), true);
        (bytes32 deployedPoolId, address deployedBook) =
            deployedRegistry.createPair(address(deployedMon), address(deployedUsdc));
        IPoolRegistry.Pool memory pool = deployedRegistry.getPool(deployedPoolId);
        require(
            pool.baseAsset == address(deployedMon) && pool.quoteAsset == address(deployedUsdc)
                && pool.book == deployedBook && pool.agnosticPricing,
            "DeployAnvil: factory pair is not MON/USDC"
        );
        deployed.mon = address(deployedMon);
        deployed.usdc = address(deployedUsdc);
        deployed.registry = address(deployedRegistry);
        deployed.exchange = deployedBook;
        deployed.poolId = deployedPoolId;
    }

    function _deployTools(address usdc) private returns (address usdt, address faucet) {
        SpotCLOBLens deployedLens = new SpotCLOBLens();
        MockERC20 deployedUsdt = new MockERC20("Tether USD", "USDT", 6);
        TokenFaucet deployedFaucet = new TokenFaucet();
        ERC20TokenFactory deployedTokenFactory = new ERC20TokenFactory();
        deployedFaucet.configureToken(usdc, FAUCET_CLAIM_AMOUNT, FAUCET_COOLDOWN);
        deployedFaucet.configureToken(address(deployedUsdt), FAUCET_CLAIM_AMOUNT, FAUCET_COOLDOWN);
        MockERC20(usdc).mint(address(deployedFaucet), FAUCET_RESERVE);
        deployedUsdt.mint(address(deployedFaucet), FAUCET_RESERVE);
        emit log_named_address("ERC20TokenFactory", address(deployedTokenFactory));
        emit log_named_address("SpotCLOBLens", address(deployedLens));
        usdt = address(deployedUsdt);
        faucet = address(deployedFaucet);
    }

    function _seedBalances(MockERC20 mon, MockERC20 usdc, SpotCLOB exchange) private {
        _fundAndApprove(
            mon, exchange, _addressFor(SELLER_A_PRIVATE_KEY), SELLER_A_PRIVATE_KEY, 100 ether
        );
        _fundAndApprove(
            mon, exchange, _addressFor(SELLER_B_PRIVATE_KEY), SELLER_B_PRIVATE_KEY, 100 ether
        );
        _fundAndApprove(
            usdc, exchange, _addressFor(BUYER_A_PRIVATE_KEY), BUYER_A_PRIVATE_KEY, 1_000_000_000
        );
        _fundAndApprove(
            usdc, exchange, _addressFor(BUYER_B_PRIVATE_KEY), BUYER_B_PRIVATE_KEY, 1_000_000_000
        );
    }

    function _fundAndApprove(
        MockERC20 token,
        SpotCLOB exchange,
        address actor,
        uint256 privateKey,
        uint256 amount
    ) private {
        vm.startBroadcast(DEPLOYER_PRIVATE_KEY);
        token.mint(actor, amount);
        vm.stopBroadcast();

        vm.startBroadcast(privateKey);
        token.approve(address(exchange), type(uint256).max);
        vm.stopBroadcast();
    }

    function _seedBook(MockERC20 mon, MockERC20 usdc, SpotCLOB exchange) private {
        _place(
            exchange,
            _addressFor(BUYER_A_PRIVATE_KEY),
            BUYER_A_PRIVATE_KEY,
            address(mon),
            address(usdc),
            ISpotCLOB.Side.Buy,
            BID_PRICE_A,
            BID_QUANTITY_A,
            1001
        );
        _place(
            exchange,
            _addressFor(BUYER_B_PRIVATE_KEY),
            BUYER_B_PRIVATE_KEY,
            address(mon),
            address(usdc),
            ISpotCLOB.Side.Buy,
            BID_PRICE_B,
            BID_QUANTITY_B,
            1002
        );
        _place(
            exchange,
            _addressFor(SELLER_A_PRIVATE_KEY),
            SELLER_A_PRIVATE_KEY,
            address(mon),
            address(usdc),
            ISpotCLOB.Side.Sell,
            ASK_PRICE_A,
            ASK_QUANTITY_A,
            2001
        );
        _place(
            exchange,
            _addressFor(SELLER_B_PRIVATE_KEY),
            SELLER_B_PRIVATE_KEY,
            address(mon),
            address(usdc),
            ISpotCLOB.Side.Sell,
            ASK_PRICE_B,
            ASK_QUANTITY_B,
            2002
        );
    }

    function _place(
        SpotCLOB exchange,
        address trader,
        uint256 privateKey,
        address baseAsset,
        address quoteAsset,
        ISpotCLOB.Side side,
        uint128 price,
        uint128 quantity,
        uint64 clientOrderId
    ) private {
        vm.startBroadcast(privateKey);
        exchange.placeLimitOrder(
            ISpotCLOB.LimitOrder({
                trader: trader,
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                side: side,
                price: price,
                quantity: quantity,
                expiry: 0,
                clientOrderId: clientOrderId
            })
        );
        vm.stopBroadcast();
    }

    function _logDeployment(
        address mon,
        address usdc,
        address registry,
        address exchange,
        bytes32 poolId
    ) private {
        emit log_string("ANVIL-ONLY deployment; all seeded accounts use deterministic Anvil dev keys");
        emit log_named_address("MON", mon);
        emit log_named_address("USDC", usdc);
        emit log_named_address("PoolRegistry", registry);
        emit log_named_address("SpotCLOB", exchange);
        emit log_named_bytes32("poolId", poolId);
        emit log_named_uint("chainId", 31_337);
        emit log_named_uint("minimumPriceX18", 1);
        emit log_named_uint("maximumPriceX18", type(uint128).max);
    }

    function _logFaucet(address usdt, address faucet) private {
        emit log_named_address("USDT", usdt);
        emit log_named_address("TokenFaucet", faucet);
        emit log_named_uint("faucetClaimAmount", FAUCET_CLAIM_AMOUNT);
        emit log_named_uint("faucetCooldown", FAUCET_COOLDOWN);
    }

    function _logAndVerifyBook(SpotCLOB exchange, bytes32 poolId) private {
        (
            bool bidExists,
            uint128 bidPrice,
            uint128 bidQuantity,
            bool askExists,
            uint128 askPrice,
            uint128 askQuantity
        ) = exchange.getBestPrices(poolId);
        require(
            bidExists && bidPrice == BID_PRICE_A && bidQuantity == BID_QUANTITY_A, "bad best bid"
        );
        require(
            askExists && askPrice == ASK_PRICE_A && askQuantity == ASK_QUANTITY_A, "bad best ask"
        );

        (ISpotCLOB.PriceLevelView[] memory bids, ISpotCLOB.PriceLevelView[] memory asks) =
            exchange.getOrderBook(poolId, 4);
        require(bids.length == 2 && asks.length == 2, "bad seeded depth");
        require(bids[0].price == BID_PRICE_A && bids[1].price == BID_PRICE_B, "bad bid ordering");
        require(asks[0].price == ASK_PRICE_A && asks[1].price == ASK_PRICE_B, "bad ask ordering");

        emit log_named_uint("bestBidPrice", bidPrice);
        emit log_named_uint("bestBidQuantity", bidQuantity);
        emit log_named_uint("bestAskPrice", askPrice);
        emit log_named_uint("bestAskQuantity", askQuantity);
        emit log_named_uint("bidLevels", bids.length);
        emit log_named_uint("askLevels", asks.length);
        emit log_string("seeded order book readback verified");
    }

    function _addressFor(uint256 privateKey) private returns (address) {
        return vm.addr(privateKey);
    }
}
