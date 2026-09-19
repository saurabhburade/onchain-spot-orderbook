import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { type Address, encodeFunctionData } from "viem";

const require = createRequire(import.meta.url);
const { clobAbi } = require("../../config/abis/clob.ts") as typeof import("../../config/abis/clob");
const { erc20Abi } = require("../../config/abis/erc20.ts") as typeof import("../../config/abis/erc20");
const { clobContractsByChainId } = require("../../config/contracts.ts") as typeof import("../../config/contracts");
const { validatePrivyOrderBatch, validatePrivySponsoredBatch } =
  require("./privy-call-validation.ts") as typeof import("./privy-call-validation");
const { buildPrivySendCallsBody, privyWalletRpcUrl, sendPrivySponsoredCalls } =
  require("./privy-wallet-api.ts") as typeof import("./privy-wallet-api");

const monadContracts = clobContractsByChainId[10143];
const token =
  monadContracts.faucetTokens.find((item) => item.symbol === "USDC")?.address ??
  (() => {
    throw new Error("Monad USDC is missing from the contract registry");
  })();
const faucet = monadContracts.faucetAddress;

const book = "0xe4a7d4a21fa977e271b3b88e3d786d740d5f530b" as Address;
const trader = "0x7c2b03f0872c700fc35e68746b4ccf0c81ee2bd7" as Address;

function orderData() {
  return encodeFunctionData({
    abi: clobAbi,
    functionName: "placeLimitOrderWithMaxBookSteps",
    args: [
      {
        trader,
        baseAsset: "0x891874554c69a1006914a8fe6b733304e73cbdb5",
        quoteAsset: token,
        side: 0,
        price: 1n,
        quantity: 1n,
        expiry: 0n,
        clientOrderId: 0n,
      },
      64,
    ],
  });
}

test("builds native Privy wallet_sendCalls without manual self.execute calldata", () => {
  const body = buildPrivySendCallsBody(10143, [
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [book, 10n] }) },
    { to: book, data: orderData() },
  ]);

  assert.equal(body.method, "wallet_sendCalls");
  assert.equal(body.caip2, "eip155:10143");
  assert.equal(body.sponsor, true);
  assert.equal(body.params.calls.length, 2);
  assert.equal(body.params.calls[0]?.value, undefined);
  assert.equal(privyWalletRpcUrl("wallet_123"), "https://api.privy.io/v1/wallets/wallet_123/rpc");
});

test("accepts the approve, order, revoke call pattern", () => {
  const body = buildPrivySendCallsBody(10143, [
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [book, 10n] }) },
    { to: book, data: orderData() },
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [book, 0n] }) },
  ]);

  assert.deepEqual(validatePrivyOrderBatch(body, 10143), body);
});

test("rejects arbitrary sponsored calls", () => {
  const body = buildPrivySendCallsBody(10143, [{ to: trader, data: "0x12345678" }]);
  assert.throws(() => validatePrivyOrderBatch(body, 10143), /only ERC-20 approvals and one order-book call/);
});

test("rejects approvals for a spender other than the order book", () => {
  const body = buildPrivySendCallsBody(10143, [
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [trader, 10n] }) },
    { to: book, data: orderData() },
  ]);
  assert.throws(() => validatePrivyOrderBatch(body, 10143), /approval must target the order-book contract/);
});

test("accepts a single CLOB cancellation call", () => {
  const body = buildPrivySendCallsBody(10143, [
    {
      to: book,
      data: encodeFunctionData({
        abi: clobAbi,
        functionName: "cancelOrder",
        args: [`0x${"11".repeat(32)}`],
      }),
    },
  ]);
  assert.deepEqual(validatePrivyOrderBatch(body, 10143), body);
});

test("allows only an allowlisted faucet claim in the sponsored proxy", () => {
  const claimData = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "claim",
        stateMutability: "nonpayable",
        inputs: [{ name: "token", type: "address" }],
        outputs: [],
      },
    ] as const,
    functionName: "claim",
    args: [token],
  });
  const body = buildPrivySendCallsBody(10143, [{ to: faucet, data: claimData }]);

  assert.deepEqual(validatePrivySponsoredBatch(body, 10143, { address: faucet, tokens: [token] }), body);
  assert.throws(
    () => validatePrivySponsoredBatch(body, 10143, { address: faucet, tokens: [trader] }),
    /not allowlisted/,
  );
});

test("binds the user authorization signature to the exact sponsored request", async () => {
  const previousAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const previousFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "app_test";
  let signedInput: unknown;
  let proxyBody: unknown;
  globalThis.fetch = async (_input, init) => {
    proxyBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ transactionId: "transaction_123" }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const transactionId = await sendPrivySponsoredCalls({
      accessToken: "access-token",
      calls: [{ to: book, data: orderData() }],
      chainId: 10143,
      generateAuthorizationSignature: async (input) => {
        signedInput = input;
        return { signature: "authorization-signature" };
      },
      walletId: "wallet_123",
    });
    assert.equal(transactionId, "transaction_123");
    assert.equal((signedInput as { url: string }).url, privyWalletRpcUrl("wallet_123"));
    assert.deepEqual((signedInput as { body: unknown }).body, (proxyBody as { request: unknown }).request);
    assert.equal(
      (signedInput as { headers: Record<string, string> }).headers["privy-request-expiry"],
      String((proxyBody as { requestExpiry: number }).requestExpiry),
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId === undefined) delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    else process.env.NEXT_PUBLIC_PRIVY_APP_ID = previousAppId;
  }
});
