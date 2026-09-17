import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const optionsSource = readFileSync(new URL("./transaction-options.ts", import.meta.url), "utf8");
const deploySource = readFileSync(
  new URL("../../components/token-tools/deploy-token-screen.tsx", import.meta.url),
  "utf8",
);
const faucetSource = readFileSync(new URL("../../components/token-tools/faucet-screen.tsx", import.meta.url), "utf8");
const hooksSource = readFileSync(new URL("./hooks.tsx", import.meta.url), "utf8");
const createMarketSource =
  hooksSource.split("export function useCreateMarket()")[1]?.split("export function useOrderbook")[0] ?? "";
const marketsSource =
  hooksSource.split("export function useMarkets()")[1]?.split("export function useCreateMarket")[0] ?? "";
const atomicOrderSource = hooksSource.split("const sendAtomicOrder")[1]?.split("const placeLimit")[0] ?? "";
const limitOrderSource = hooksSource.split("const placeLimit")[1]?.split("const executeMarket")[0] ?? "";
const marketOrderSource = hooksSource.split("const executeMarket")[1]?.split("const cancel")[0] ?? "";
const actionRunnerSource = hooksSource.split("const run = useCallback")[1]?.split("const sendAtomicOrder")[0] ?? "";
const privyOrderSource = hooksSource.split("const sendPrivyOrder")[1]?.split("const sendAtomicOrder")[0] ?? "";

describe("headless sponsored token deployment", () => {
  it("hides the wallet UI and limits sponsorship to Monad Testnet", () => {
    assert.match(optionsSource, /sponsor:\s*chainId\s*===\s*MONAD_TESTNET_CHAIN_ID/);
    assert.match(optionsSource, /showWalletUIs:\s*false/);
  });

  it("uses the headless transaction options when deploying a token", () => {
    assert.match(deploySource, /sendTransaction\s*\(/);
    assert.match(deploySource, /headlessTransactionOptions\(wallet\.address,\s*chainId\)/);
    assert.doesNotMatch(deploySource, /createPrivyWalletClient/);
  });

  it("uses the headless transaction options when claiming faucet tokens", () => {
    assert.match(faucetSource, /sendTransaction\s*\(/);
    assert.match(faucetSource, /headlessTransactionOptions\(wallet\.address,\s*chainId\)/);
    assert.doesNotMatch(faucetSource, /createPrivyWalletClient/);
  });

  it("uses the headless transaction options when creating a market", () => {
    assert.match(createMarketSource, /sendTransaction\s*\(/);
    assert.match(createMarketSource, /headlessTransactionOptions\(wallet\.address,\s*chainId\)/);
    assert.doesNotMatch(createMarketSource, /createPrivyWalletClient/);
    assert.match(createMarketSource, /getBytecode\(\{\s*address:\s*factoryAddress\s*\}\)/);
    assert.match(createMarketSource, /isUnsupportedContractFunctionError\(error\)/);
    assert.match(createMarketSource, /legacyCreatePairArgs\(input\.baseAsset,\s*input\.quoteAsset\)/);
    assert.match(createMarketSource, /value:\s*creationFee/);
  });

  it("resolves market icons from decoded asset addresses after explicit listing overrides", () => {
    assert.match(
      marketsSource,
      /baseIconUrl:\s*configuredMarket\.baseIconUrl\s*\?\?\s*listedTokenIconUrl\(chainId,\s*market\.baseAsset\)/,
    );
    assert.match(
      marketsSource,
      /quoteIconUrl:\s*configuredMarket\.quoteIconUrl\s*\?\?\s*listedTokenIconUrl\(chainId,\s*market\.quoteAsset\)/,
    );
  });

  it("atomically approves a bounded reusable allowance and places the order", () => {
    assert.match(atomicOrderSource, /encodeAtomicBatch\s*\(/);
    assert.match(atomicOrderSource, /args:\s*\[spender,\s*approvalAmount\]/);
    assert.doesNotMatch(atomicOrderSource, /args:\s*\[spender,\s*0n\]/);
    assert.match(atomicOrderSource, /to:\s*activeWallet\.address/);
    assert.match(atomicOrderSource, /headlessTransactionOptions\(activeWallet\.address,\s*chainId\)/);
    assert.doesNotMatch(atomicOrderSource, /waitForTransaction\(chainId,\s*approvalHash\)/);
  });

  it("reuses the bounded allowance for limit and market orders", () => {
    assert.doesNotMatch(atomicOrderSource, /clearUnusedAllowance/);
    assert.match(limitOrderSource, /sendAtomicOrder\(orderAsset,\s*contractAddress,\s*escrowAmount,\s*data\)/);
    assert.match(marketOrderSource, /sendAtomicOrder\(orderAsset,\s*contractAddress,\s*escrowAmount,\s*data\)/);
  });

  it("sends every Monad order through the one-address Privy sponsored path", () => {
    assert.match(atomicOrderSource, /if\s*\(allowance\s*<\s*amount\)/);
    assert.match(atomicOrderSource, /if\s*\(chainId\s*===\s*MONAD_TESTNET_CHAIN_ID\)\s*return sendPrivyOrder\(calls\)/);
    assert.match(atomicOrderSource, /args:\s*\[activeTrader,\s*spender\]/);
  });

  it("reuses an in-flight action instead of sending duplicate wallet RPC requests", () => {
    assert.match(actionRunnerSource, /pendingTransactionRef\.current/);
    assert.match(actionRunnerSource, /if\s*\(pendingTransactionRef\.current\)\s*return pendingTransactionRef\.current/);
  });

  it("completes Privy order feedback as soon as its transaction hash is available", () => {
    assert.match(privyOrderSource, /waitForPrivyTransaction\s*\(/);
    assert.doesNotMatch(privyOrderSource, /waitForTransaction\s*\(/);
  });
});
