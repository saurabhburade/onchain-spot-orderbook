// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TokenFaucet } from "../src/TokenFaucet.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";

interface FaucetVm {
    function warp(uint256 timestamp) external;
}

contract FaucetUser {
    function claim(TokenFaucet faucet, address token) external {
        faucet.claim(token);
    }

    function configure(TokenFaucet faucet, address token, uint256 amount, uint256 cooldown)
        external
    {
        faucet.configureToken(token, amount, cooldown);
    }

    function withdraw(TokenFaucet faucet, address token, address to, uint256 amount) external {
        faucet.withdrawToken(token, to, amount);
    }
}

contract TokenFaucetTest {
    uint256 private constant CLAIM_AMOUNT = 10_000e6;
    uint256 private constant COOLDOWN = 1 days;
    address private constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    FaucetVm private constant vm = FaucetVm(VM_ADDRESS);

    TokenFaucet private faucet;
    MockERC20 private usdc;
    MockERC20 private usdt;
    FaucetUser private alice;

    function setUp() public {
        faucet = new TokenFaucet();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdt = new MockERC20("Tether USD", "USDT", 6);
        alice = new FaucetUser();

        faucet.configureToken(address(usdc), CLAIM_AMOUNT, COOLDOWN);
        faucet.configureToken(address(usdt), CLAIM_AMOUNT, COOLDOWN);
        usdc.mint(address(faucet), CLAIM_AMOUNT * 10);
        usdt.mint(address(faucet), CLAIM_AMOUNT * 10);
    }

    function testAnyoneCanClaimEachConfiguredToken() public {
        alice.claim(faucet, address(usdc));
        alice.claim(faucet, address(usdt));

        require(usdc.balanceOf(address(alice)) == CLAIM_AMOUNT, "wrong USDC claim");
        require(usdt.balanceOf(address(alice)) == CLAIM_AMOUNT, "wrong USDT claim");
        require(
            faucet.nextClaimAt(address(alice), address(usdc)) == block.timestamp + COOLDOWN,
            "wrong next claim time"
        );
    }

    function testClaimPaysOnlyTheCaller() public {
        alice.claim(faucet, address(usdc));

        require(usdc.balanceOf(address(alice)) == CLAIM_AMOUNT, "caller was not paid");
        require(usdc.balanceOf(address(this)) == 0, "faucet owner was paid");
    }

    function testClaimEnforcesPerTokenCooldown() public {
        alice.claim(faucet, address(usdc));
        require(!_callClaim(alice, address(usdc)), "second claim ignored cooldown");

        vm.warp(block.timestamp + COOLDOWN);
        alice.claim(faucet, address(usdc));
        require(usdc.balanceOf(address(alice)) == CLAIM_AMOUNT * 2, "claim after cooldown failed");
    }

    function testDisabledAndUnconfiguredTokensCannotBeClaimed() public {
        MockERC20 other = new MockERC20("Other", "OTHER", 18);
        require(!_callClaim(alice, address(other)), "unconfigured token was claimed");

        (bool disabledUnconfigured,) =
            address(faucet).call(abi.encodeCall(TokenFaucet.disableToken, (address(other))));
        require(!disabledUnconfigured, "unconfigured token was disabled");

        faucet.disableToken(address(usdc));
        require(!_callClaim(alice, address(usdc)), "disabled token was claimed");
    }

    function testOnlyOwnerCanConfigureOrWithdraw() public {
        require(
            !_callConfigure(alice, address(usdc), CLAIM_AMOUNT * 2, COOLDOWN),
            "non-owner configured token"
        );
        require(
            !_callWithdraw(alice, address(usdc), address(alice), CLAIM_AMOUNT),
            "non-owner withdrew reserves"
        );

        faucet.withdrawToken(address(usdc), address(this), CLAIM_AMOUNT);
        require(usdc.balanceOf(address(this)) == CLAIM_AMOUNT, "owner withdrawal failed");
    }

    function testRejectsInvalidConfiguration() public {
        require(!_callConfigureSelf(address(0), CLAIM_AMOUNT, COOLDOWN), "zero token configured");
        require(
            !_callConfigureSelf(address(0x1234), CLAIM_AMOUNT, COOLDOWN),
            "non-contract token configured"
        );
        require(!_callConfigureSelf(address(usdc), 0, COOLDOWN), "zero claim configured");
    }

    function testRejectsInvalidWithdrawalAddresses() public {
        require(!_callWithdrawSelf(address(0), address(this), 1), "zero token withdrawn");
        require(!_callWithdrawSelf(address(usdc), address(0), 1), "withdrawal to zero succeeded");
    }

    function testRevertsWhenFaucetHasInsufficientReserves() public {
        faucet.configureToken(address(usdc), CLAIM_AMOUNT * 11, 0);
        require(!_callClaim(alice, address(usdc)), "underfunded claim succeeded");
        require(
            faucet.nextClaimAt(address(alice), address(usdc)) == 0, "failed claim used cooldown"
        );
    }

    function _callClaim(FaucetUser user, address token) private returns (bool success) {
        (success,) = address(user).call(abi.encodeCall(FaucetUser.claim, (faucet, token)));
    }

    function _callConfigure(FaucetUser user, address token, uint256 amount, uint256 cooldown)
        private
        returns (bool success)
    {
        (success,) = address(user)
            .call(abi.encodeCall(FaucetUser.configure, (faucet, token, amount, cooldown)));
    }

    function _callConfigureSelf(address token, uint256 amount, uint256 cooldown)
        private
        returns (bool success)
    {
        (success,) = address(faucet)
            .call(abi.encodeCall(TokenFaucet.configureToken, (token, amount, cooldown)));
    }

    function _callWithdraw(FaucetUser user, address token, address to, uint256 amount)
        private
        returns (bool success)
    {
        (success,) = address(user)
            .call(abi.encodeCall(FaucetUser.withdraw, (faucet, token, to, amount)));
    }

    function _callWithdrawSelf(address token, address to, uint256 amount)
        private
        returns (bool success)
    {
        (success,) = address(faucet)
            .call(abi.encodeCall(TokenFaucet.withdrawToken, (token, to, amount)));
    }
}
