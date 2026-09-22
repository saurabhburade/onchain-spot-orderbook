import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const optionsSource = readFileSync(new URL("./transaction-options.ts", import.meta.url), "utf8");
const deploySource = readFileSync(
  new URL("../../components/token-tools/deploy-token-screen.tsx", import.meta.url),
  "utf8",
);
const faucetSource = readFileSync(new URL("../../components/token-tools/faucet-screen.tsx", import.meta.url), "utf8");
const hooksSource = readFileSync(new URL("../../hooks/use-clob.tsx", import.meta.url), "utf8");
const tradingScreenSource = readFileSync(
  new URL("../../components/trading/trading-screen.tsx", import.meta.url),
  "utf8",
);
const directClientSource = readFileSync(new URL("./direct-userop-client.ts", import.meta.url), "utf8");
const kernelSessionClientSource = readFileSync(new URL("./kernel-session-client.ts", import.meta.url), "utf8");
const userOpAuthRouteSource = readFileSync(new URL("../../app/api/userops/auth/route.ts", import.meta.url), "utf8");
const userOpSubmitRouteSource = readFileSync(new URL("../../app/api/userops/submit/route.ts", import.meta.url), "utf8");
const createMarketSource =
  hooksSource.split("export function useCreateMarket()")[1]?.split("export function useOrderbook")[0] ?? "";
const marketsSource =
  hooksSource.split("export function useMarkets()")[1]?.split("export function useCreateMarket")[0] ?? "";
const atomicOrderSource = hooksSource.split("const sendAtomicOrder")[1]?.split("const placeLimit")[0] ?? "";
const limitOrderSource = hooksSource.split("const placeLimit")[1]?.split("const executeMarket")[0] ?? "";
const marketOrderSource = hooksSource.split("const executeMarket")[1]?.split("const cancel")[0] ?? "";
const actionRunnerSource = hooksSource.split("const run = useCallback")[1]?.split("const sendAtomicOrder")[0] ?? "";
const privyOrderSource = hooksSource.split("const sendPrivyOrder")[1]?.split("const sendDirectOrder")[0] ?? "";
const directOrderSource = hooksSource.split("const sendDirectOrder")[1]?.split("const sendAtomicOrder")[0] ?? "";

describe("headless sponsored token deployment", () => {
  it("hides the wallet UI and limits sponsorship to Monad Testnet", () => {
    assert.match(optionsSource, /sponsor:\s*chainId\s*===\s*MONAD_TESTNET_CHAIN_ID/);
    assert.match(optionsSource, /showWalletUIs:\s*false/);
  });

  it("uses the headless transaction options when deploying a token", () => {
    assert.match(deploySource, /sendTransaction\s*\(/);
    assert.match(deploySource, /headlessTransactionOptions\(wallet\.address,\s*chainId\)/);
    assert.match(deploySource, /submitDirectUserOperationWithSessionKey/);
    assert.match(deploySource, /onAccountNotDelegated/);
    assert.doesNotMatch(deploySource, /createPrivyWalletClient/);
  });

  it("uses the headless transaction options when claiming faucet tokens", () => {
    assert.match(faucetSource, /sendTransaction\s*\(/);
    assert.match(faucetSource, /headlessTransactionOptions\(wallet\.address,\s*chainId\)/);
    assert.match(faucetSource, /submitDirectUserOperationWithSessionKey/);
    assert.match(faucetSource, /onAccountNotDelegated/);
    assert.match(faucetSource, /if\s*\(!submittedWithSponsorship\)\s*await waitForTransaction\(chainId,\s*hash\)/);
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
    assert.match(createMarketSource, /submitDirectUserOperationWithSessionKey/);
    assert.match(createMarketSource, /calls:\s*\[\{ to: factoryAddress, data, value: creationFee \}\]/);
  });

  it("resolves market icons from decoded asset addresses after explicit listing overrides", () => {
    assert.match(
      marketsSource,
      /baseIconUrl:\s*configuredMarket\?\.baseIconUrl\s*\?\?\s*listedTokenIconUrl\(chainId,\s*market\.baseAsset\)/,
    );
    assert.match(
      marketsSource,
      /quoteIconUrl:\s*configuredMarket\?\.quoteIconUrl\s*\?\?\s*listedTokenIconUrl\(chainId,\s*market\.quoteAsset\)/,
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

  it("prepares every Monad order for direct UserOperation signing", () => {
    assert.match(atomicOrderSource, /if\s*\(allowance\s*<\s*amount\)/);
    assert.match(
      atomicOrderSource,
      /if\s*\(chainId\s*===\s*MONAD_TESTNET_CHAIN_ID\)\s*return sendDirectOrder\(calls\)/,
    );
    assert.match(atomicOrderSource, /args:\s*\[activeTrader,\s*spender\]/);
    assert.match(directOrderSource, /submitDirectUserOperationWithSessionKey\(/);
    assert.match(directOrderSource, /onAccountNotDelegated: \(\) => sendPrivyOrder\(calls\)/);
    assert.doesNotMatch(directOrderSource, /waitForTransaction\(/);
    assert.match(directClientSource, /const signStartedAt = performance\.now\(\)/);
    assert.match(directClientSource, /const signMs = Math\.round\(performance\.now\(\) - signStartedAt\)/);
    assert.match(directClientSource, /const submitStartedAt = performance\.now\(\)/);
    assert.match(directClientSource, /const submitMs = Math\.round\(performance\.now\(\) - submitStartedAt\)/);
    assert.match(directClientSource, /console\.info\("Direct UserOperation latency"/);
  });

  it("shows direct submission latency in the trading feedback", () => {
    assert.match(tradingScreenSource, /clob\.transaction\.metrics/);
    assert.match(tradingScreenSource, /Submitted in \$\{clob\.transaction\.metrics\.totalMs\} ms/);
    assert.match(tradingScreenSource, /sign \$\{clob\.transaction\.metrics\.signMs\} ms/);
    assert.match(tradingScreenSource, /API \$\{clob\.transaction\.metrics\.submitMs\} ms/);
    assert.match(tradingScreenSource, /RPC wall/);
    assert.match(tradingScreenSource, /nonce/);
    assert.match(tradingScreenSource, /delegation/);
    assert.match(tradingScreenSource, /order book/);
    assert.match(tradingScreenSource, /chain/);
    assert.match(tradingScreenSource, /auth/);
    assert.match(tradingScreenSource, /RPC batch wall/);
    assert.match(tradingScreenSource, /simulation/);
    assert.match(tradingScreenSource, /sponsor fields/);
    assert.match(tradingScreenSource, /gas price/);
    assert.match(tradingScreenSource, /broadcast/);
    assert.match(tradingScreenSource, /eth_sendRawTransaction/);
    assert.match(tradingScreenSource, /response/);
  });

  it("keeps transaction latency UI and console logs out of production", () => {
    assert.match(tradingScreenSource, /showTransactionLatency\s*=\s*process\.env\.NODE_ENV\s*!==\s*"production"/);
    assert.match(tradingScreenSource, /showTransactionLatency\s*&&\s*clob\.transaction\.metrics/);
    assert.match(deploySource, /showTransactionLatency\s*&&\s*deployed\.metrics/);
    for (const source of [
      directClientSource,
      kernelSessionClientSource,
      userOpAuthRouteSource,
      userOpSubmitRouteSource,
    ]) {
      assert.match(source, /logTransactionLatency\s*=\s*process\.env\.NODE_ENV\s*!==\s*"production"/);
      assert.match(source, /if\s*\(logTransactionLatency\)\s*console\.info/);
    }
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
