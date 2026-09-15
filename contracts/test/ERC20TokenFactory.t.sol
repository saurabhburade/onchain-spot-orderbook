// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20TokenFactory } from "../src/ERC20TokenFactory.sol";
import { MintableERC20 } from "../src/MintableERC20.sol";

contract TokenCreator {
    function deployDirect(address owner_) external returns (MintableERC20) {
        return new MintableERC20("Token", "TKN", 18, owner_, 0);
    }

    function create(
        ERC20TokenFactory factory,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply
    ) external returns (address) {
        return factory.createToken(name, symbol, decimals, initialSupply);
    }

    function mint(MintableERC20 token, address to, uint256 amount) external {
        token.mint(to, amount);
    }

    function transfer(MintableERC20 token, address to, uint256 amount) external {
        require(token.transfer(to, amount), "transfer failed");
    }

    function approve(MintableERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function transferFrom(MintableERC20 token, address from, address to, uint256 amount) external {
        require(token.transferFrom(from, to, amount), "transferFrom failed");
    }

    function transferOwnership(MintableERC20 token, address newOwner) external {
        token.transferOwnership(newOwner);
    }

    function attemptTransfer(MintableERC20 token, address to, uint256 amount)
        external
        returns (bool success)
    {
        (success,) = address(token).call(abi.encodeCall(MintableERC20.transfer, (to, amount)));
    }

    function attemptTransferFrom(MintableERC20 token, address from, address to, uint256 amount)
        external
        returns (bool success)
    {
        (success,) =
            address(token).call(abi.encodeCall(MintableERC20.transferFrom, (from, to, amount)));
    }

    function attemptMint(MintableERC20 token, address to, uint256 amount)
        external
        returns (bool success)
    {
        (success,) = address(token).call(abi.encodeCall(MintableERC20.mint, (to, amount)));
    }

    function attemptTransferOwnership(MintableERC20 token, address newOwner)
        external
        returns (bool success)
    {
        (success,) = address(token)
            .call(abi.encodeCall(MintableERC20.transferOwnership, (newOwner)));
    }
}

contract ERC20TokenFactoryTest {
    ERC20TokenFactory private factory;
    TokenCreator private alice;
    TokenCreator private bob;

    function setUp() public {
        factory = new ERC20TokenFactory();
        alice = new TokenCreator();
        bob = new TokenCreator();
    }

    function testAnyoneCanCreateTokenWithMetadataAndInitialSupply() public {
        address deployed = alice.create(factory, "USD Coin", "USDC", 6, 1_000_000e6);
        MintableERC20 token = MintableERC20(deployed);

        require(keccak256(bytes(token.name())) == keccak256("USD Coin"), "wrong name");
        require(keccak256(bytes(token.symbol())) == keccak256("USDC"), "wrong symbol");
        require(token.decimals() == 6, "wrong decimals");
        require(token.owner() == address(alice), "creator is not owner");
        require(token.totalSupply() == 1_000_000e6, "wrong total supply");
        require(token.balanceOf(address(alice)) == 1_000_000e6, "creator was not funded");
    }

    function testIndexesAllTokensAndTokensByCreator() public {
        address first = alice.create(factory, "USD Coin", "USDC", 6, 0);
        address second = bob.create(factory, "Tether USD", "USDT", 6, 0);
        address third = alice.create(factory, "Wrapped Ether", "WETH", 18, 0);

        require(factory.allTokensLength() == 3, "wrong total token count");
        require(factory.tokenAt(0) == first, "wrong first token");
        require(factory.tokenAt(1) == second, "wrong second token");
        require(factory.tokenAt(2) == third, "wrong third token");
        require(factory.tokensByCreatorLength(address(alice)) == 2, "wrong creator count");
        require(factory.tokenByCreatorAt(address(alice), 0) == first, "wrong creator token 0");
        require(factory.tokenByCreatorAt(address(alice), 1) == third, "wrong creator token 1");
    }

    function testOnlyOwnerCanMintAndOwnershipCanBeTransferred() public {
        MintableERC20 token = MintableERC20(alice.create(factory, "USD Coin", "USDC", 6, 0));

        alice.mint(token, address(bob), 10_000e6);
        require(token.balanceOf(address(bob)) == 10_000e6, "owner mint failed");
        require(!_callMint(bob, token, address(bob), 1), "non-owner mint succeeded");

        alice.transferOwnership(token, address(bob));
        bob.mint(token, address(bob), 1);
        require(token.owner() == address(bob), "ownership did not transfer");
        require(token.balanceOf(address(bob)) == 10_000e6 + 1, "new owner mint failed");
        require(!_callMint(alice, token, address(alice), 1), "old owner still minted");
    }

    function testSupportsTransfersApprovalsAndInfiniteAllowance() public {
        MintableERC20 token = MintableERC20(alice.create(factory, "Token", "TKN", 18, 100 ether));

        alice.transfer(token, address(bob), 20 ether);
        require(token.balanceOf(address(bob)) == 20 ether, "transfer failed");

        alice.approve(token, address(bob), type(uint256).max);
        bob.transferFrom(token, address(alice), address(bob), 5 ether);
        require(token.balanceOf(address(bob)) == 25 ether, "transferFrom failed");
        require(
            token.allowance(address(alice), address(bob)) == type(uint256).max,
            "infinite allowance changed"
        );
    }

    function testFiniteAllowanceDecrementsAndRejectsInsufficientAllowance() public {
        MintableERC20 token = MintableERC20(alice.create(factory, "Token", "TKN", 18, 100));
        alice.approve(token, address(bob), 7);
        bob.transferFrom(token, address(alice), address(bob), 5);
        require(token.allowance(address(alice), address(bob)) == 2, "allowance not reduced");
        require(
            !bob.attemptTransferFrom(token, address(alice), address(bob), 3),
            "insufficient allowance succeeded"
        );
    }

    function testRejectsZeroOwnerRecipientAndInsufficientBalance() public {
        (bool zeroOwner,) =
            address(alice).call(abi.encodeCall(TokenCreator.deployDirect, (address(0))));
        require(!zeroOwner, "zero owner accepted");

        MintableERC20 token = MintableERC20(alice.create(factory, "Token", "TKN", 18, 1));
        require(!alice.attemptMint(token, address(0), 1), "mint to zero succeeded");
        require(!alice.attemptTransferOwnership(token, address(0)), "ownership transferred to zero");
        require(!alice.attemptTransfer(token, address(0), 1), "transfer to zero succeeded");
        require(!alice.attemptTransfer(token, address(bob), 2), "overspend succeeded");
    }

    function testRejectsEmptyMetadata() public {
        require(!_callCreate(alice, "", "TKN"), "empty name succeeded");
        require(!_callCreate(alice, "Token", ""), "empty symbol succeeded");
        require(factory.allTokensLength() == 0, "failed tokens were indexed");
    }

    function _callCreate(TokenCreator creator, string memory name, string memory symbol)
        private
        returns (bool success)
    {
        (success,) = address(creator)
            .call(abi.encodeCall(TokenCreator.create, (factory, name, symbol, 18, 0)));
    }

    function _callMint(TokenCreator creator, MintableERC20 token, address to, uint256 amount)
        private
        returns (bool success)
    {
        (success,) = address(creator).call(abi.encodeCall(TokenCreator.mint, (token, to, amount)));
    }
}
