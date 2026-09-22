import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { type Address, encodeFunctionData, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const {
  ACCOUNT_NOT_DELEGATED,
  createDirectUserOperationClients,
  EIP7702_DELEGATION_PREFIX,
  ENTRY_POINT_V07,
  KERNEL_V33_DELEGATE,
  MAX_OUTER_GAS_LIMIT,
  USEROP_CALL_GAS_LIMIT,
  USEROP_VERIFICATION_GAS_LIMIT,
  encodeAllowedCalls,
  encodeKernelSingleCall,
  localUserOpHash,
  packUint128Pair,
  parsePackedUserOperation,
  prepareDirectUserOperation,
  submitDirectUserOperation,
} = require("./direct-userop.ts") as typeof import("./direct-userop");
const { clobAbi } = require("../../config/abis/clob.ts") as typeof import("../../config/abis/clob");
const { poolRegistryAbi } =
  require("../../config/abis/pool-registry.ts") as typeof import("../../config/abis/pool-registry");
const { tokenFactoryAbi } = require("../../config/abis/token.ts") as typeof import("../../config/abis/token");
const { clobContractsByChainId } = require("../../config/contracts.ts") as typeof import("../../config/contracts");
const directUserOpSource = readFileSync(new URL("./direct-userop.ts", import.meta.url), "utf8");

const book = "0x0000000000000000000000000000000000000001" as Address;
const token = "0x0000000000000000000000000000000000000002" as Address;
const kernelCode = `${EIP7702_DELEGATION_PREFIX}${KERNEL_V33_DELEGATE.slice(2)}` as Hex;
function orderDataFor(trader: Address, clientOrderId = 0n) {
  return encodeFunctionData({
    abi: clobAbi,
    functionName: "placeLimitOrderWithMaxBookSteps",
    args: [
      {
        trader,
        baseAsset: token,
        quoteAsset: "0x0000000000000000000000000000000000000003",
        side: 0,
        price: 1n,
        quantity: 1n,
        expiry: 0n,
        clientOrderId,
      },
      1,
    ],
  });
}

const orderData = orderDataFor(book);

function orderValidationClient() {
  return {
    readContract: async (input: { functionName: string }) => {
      if (input.functionName === "getPair") return book;
      return [{ trader: book, baseAsset: token, quoteAsset: "0x0000000000000000000000000000000000000003" }];
    },
  };
}

function rawBroadcastWallet(
  account: ReturnType<typeof privateKeyToAccount>,
  onBroadcast: (input: { request: { gas: bigint }; serializedTransaction: Hex }) => void = () => undefined,
) {
  let preparedRequest: { gas: bigint } | undefined;
  const signingAccount = {
    ...account,
    signTransaction: async (request: { gas: bigint }, options?: unknown) => {
      preparedRequest = request;
      return account.signTransaction(request as never, options as never);
    },
  };
  return {
    account: signingAccount,
    chain: { id: 10_143 },
    request: async (input: { method: string; params: readonly [Hex] }) => {
      assert.equal(input.method, "eth_sendRawTransaction");
      assert.ok(preparedRequest);
      assert.match(input.params[0], /^0x/);
      onBroadcast({ request: preparedRequest, serializedTransaction: input.params[0] });
      return `0x${"55".repeat(32)}`;
    },
  };
}

test("packs the v0.7 gas pairs and encodes a delegated Kernel call", () => {
  assert.equal(packUint128Pair(1n, 2n), `0x${"00".repeat(15)}01${"00".repeat(15)}02`);
  const callData = encodeKernelSingleCall(book, orderData);
  assert.match(callData, /^0x/);
  assert.notEqual(callData, orderData);
});

test("budgets enough call gas for the observed CLOB market-order path", () => {
  const knownSuccessfulCallGasLimit = 3_925_205n;
  assert.ok(USEROP_CALL_GAS_LIMIT > knownSuccessfulCallGasLimit);
  assert.ok(MAX_OUTER_GAS_LIMIT > USEROP_CALL_GAS_LIMIT);
});

test("batches direct relay RPC reads without transport retries", () => {
  assert.match(directUserOpSource, /batch:\s*\{\s*batchSize:\s*10,\s*wait:\s*0\s*\}/);
  assert.match(directUserOpSource, /retryCount:\s*0/);
});

test("validates and binds the existing allowlisted calls", async () => {
  const validationClient = orderValidationClient();
  const single = await encodeAllowedCalls([{ to: book, data: orderData }], book, validationClient);
  assert.equal(single.calls.length, 1);
  assert.equal(single.callData, encodeKernelSingleCall(book, orderData));

  const approve = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ] as const,
    functionName: "approve",
    args: [book, 1n],
  });
  const batch = await encodeAllowedCalls(
    [
      { to: token, data: approve },
      { to: book, data: orderData },
    ],
    book,
    validationClient,
  );
  assert.equal(batch.calls.length, 2);
  assert.notEqual(batch.callData, encodeKernelSingleCall(book, orderData));
  await assert.rejects(
    () => encodeAllowedCalls([{ to: book, data: "0x12345678" }], book, validationClient),
    /supported function|only ERC-20/i,
  );
});

test("canonicalizes faucet claims and withdrawals before sponsorship", async () => {
  const network = clobContractsByChainId[10143];
  const faucet = network.faucetAddress;
  const faucetToken = network.faucetTokens.at(0)?.address;
  assert.ok(faucetToken);
  const claim = encodeFunctionData({
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
    args: [faucetToken],
  });
  const transfer = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ] as const,
    functionName: "transfer",
    args: [book, 1n],
  });
  await assert.rejects(
    () => encodeAllowedCalls([{ to: faucet, data: `${claim}00` }], book, {}),
    /canonical|configured faucet/i,
  );
  await assert.rejects(
    () => encodeAllowedCalls([{ to: faucetToken, data: `${transfer}00` }], book, {}),
    /canonical|configured assets/i,
  );
});

test("allows every remaining UI transaction through a bounded canonical intent", async () => {
  const network = clobContractsByChainId[10143];
  const recipient = "0x0000000000000000000000000000000000000004" as Address;
  const arbitraryToken = "0x0000000000000000000000000000000000000005" as Address;
  const transfer = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ] as const,
    functionName: "transfer",
    args: [recipient, 1n],
  });
  const native = await encodeAllowedCalls([{ to: recipient, value: "0x1" }], book, {});
  assert.equal(native.calls[0]?.value, 1n);

  const withdrawal = await encodeAllowedCalls([{ to: arbitraryToken, data: transfer }], book, {});
  assert.equal(withdrawal.calls[0]?.to, arbitraryToken);

  const createToken = encodeFunctionData({
    abi: tokenFactoryAbi,
    functionName: "createToken",
    args: ["Example USD", "XUSD", 6, 1_000_000n],
  });
  const deployment = await encodeAllowedCalls([{ to: network.tokenFactoryAddress, data: createToken }], book, {});
  assert.equal(deployment.calls[0]?.to, network.tokenFactoryAddress);

  const createPair = encodeFunctionData({
    abi: poolRegistryAbi,
    functionName: "createPair",
    args: [arbitraryToken, recipient],
  });
  const market = await encodeAllowedCalls([{ to: network.factoryAddress, data: createPair, value: "0x7" }], book, {
    readContract: async () => 7n,
  });
  assert.equal(market.calls[0]?.value, 7n);

  const approval = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ] as const,
    functionName: "approve",
    args: [recipient, 1n],
  });
  await assert.rejects(() => encodeAllowedCalls([{ to: arbitraryToken, data: approval }], book, {}), /Approval-only/);
});

test("parses only unsigned packed operations with bounded fields", () => {
  const operation = {
    sender: book,
    nonce: "0x10000000000000007",
    initCode: "0x",
    callData: encodeKernelSingleCall(book, orderData),
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  } as const;
  assert.deepEqual(parsePackedUserOperation(operation, true), operation);
  assert.throws(() => parsePackedUserOperation({ ...operation, nonce: 7 }, true), /hex string/);
  assert.throws(() => parsePackedUserOperation({ ...operation, signature: "0x01" }, true), /must be 0x/);
  assert.throws(() => parsePackedUserOperation({ ...operation, extra: "0x" }, true), /unsupported field/);
});

test("preparation checks Monad and returns the exact unsigned signing payload", async () => {
  const sender = book;
  let nonceKey: bigint | undefined;
  const publicClient = {
    getGasPrice: async () => 1n,
    getTransactionCount: async () => 0,
    getChainId: async () => 10143,
    getCode: async () => kernelCode,
    readContract: async (input: { functionName: string; args: unknown[] }) => {
      if (input.functionName === "getNonce") nonceKey = input.args[1] as bigint;
      if (input.functionName === "getPair") return book;
      return input.functionName === "getUserOpHash" ? `0x${"11".repeat(32)}` : 7n;
    },
  };
  const result = await prepareDirectUserOperation({
    sender,
    calls: [{ to: book, data: orderData }],
    publicClient,
  });
  assert.equal(result.operation.signature, "0x");
  assert.equal(result.operation.sender, sender);
  assert.equal(result.userOpHash, localUserOpHash(result.operation));
  assert.ok(result.timing.rpcWallMs >= 0);
  assert.ok(result.timing.chainIdMs >= 0);
  assert.ok(result.timing.delegationMs >= 0);
  assert.ok(result.timing.orderBookMs >= 0);
  assert.ok(result.timing.nonceMs >= 0);
  assert.ok(result.timing.localMs >= 0);
  assert.ok(nonceKey !== undefined && nonceKey > 0n && nonceKey < 1n << 176n);
});

test("preparation uses an exact Kernel permission nonce namespace supplied by the browser", async () => {
  const sender = book;
  const permissionNonceKey = BigInt(`0x0102${"00".repeat(16)}112233440000`);
  let observedNonceKey: bigint | undefined;
  const publicClient = {
    getGasPrice: async () => 1n,
    getTransactionCount: async () => 0,
    getChainId: async () => 10_143,
    getCode: async () => kernelCode,
    readContract: async (input: { functionName: string; args: unknown[] }) => {
      if (input.functionName === "getNonce") {
        observedNonceKey = input.args[1] as bigint;
        return (permissionNonceKey << 64n) + 3n;
      }
      if (input.functionName === "getPair") return book;
      return `0x${"11".repeat(32)}`;
    },
  };

  const result = await prepareDirectUserOperation({
    sender,
    calls: [{ to: book, data: orderData }],
    nonceKey: `0x${permissionNonceKey.toString(16)}`,
    publicClient,
  });

  assert.equal(observedNonceKey, permissionNonceKey);
  assert.equal(BigInt(result.operation.nonce) >> 64n, permissionNonceKey);
});

test("prepares a session UserOperation without any chain RPC", async () => {
  const sender = book;
  const permissionNonceKey = BigInt(`0x0002${"11".repeat(16)}223344550000`);
  const publicClient = new Proxy(
    {},
    {
      get() {
        throw new Error("prepare must not access the RPC client");
      },
    },
  );

  const result = await prepareDirectUserOperation({
    sender,
    calls: [{ to: book, data: orderData }],
    nonceKey: `0x${permissionNonceKey.toString(16)}`,
    nonceSequence: "0x3",
    publicClient,
  });

  assert.equal(BigInt(result.operation.nonce), (permissionNonceKey << 64n) | 3n);
  assert.equal(result.timing.rpcWallMs, 0);
  assert.equal(result.timing.chainIdMs, 0);
  assert.equal(result.timing.delegationMs, 0);
  assert.equal(result.timing.orderBookMs, 0);
  assert.equal(result.timing.nonceMs, 0);
});

test("configures the sponsor account with the shared process nonce manager", () => {
  const previousKey = process.env.SPONSER_PK;
  process.env.SPONSER_PK = "0x3333333333333333333333333333333333333333333333333333333333333333";
  try {
    const { walletClient } = createDirectUserOperationClients();
    assert.equal(walletClient.account?.nonceManager, nonceManager);
  } finally {
    if (previousKey === undefined) delete process.env.SPONSER_PK;
    else process.env.SPONSER_PK = previousKey;
  }
});

test("preparation returns the delegated-account contract error", async () => {
  await assert.rejects(
    () =>
      prepareDirectUserOperation({
        sender: book,
        calls: [{ to: book, data: orderData }],
        publicClient: {
          getChainId: async () => 10143,
          getCode: async () => "0x",
          readContract: async () => 0n,
        },
      }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, ACCOUNT_NOT_DELEGATED);
      assert.equal((error as { status: number }).status, 409);
      return true;
    },
  );
});

test("submission verifies the exact signed hash before broadcasting handleOps", async () => {
  const user = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
  const sponsor = privateKeyToAccount("0x3333333333333333333333333333333333333333333333333333333333333333");
  const signedOrderData = orderDataFor(user.address);
  const callData = encodeKernelSingleCall(book, signedOrderData);
  const nonce = (1n << 64n) + 7n;
  const operation = {
    sender: user.address,
    nonce: `0x${nonce.toString(16)}`,
    initCode: "0x",
    callData,
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  } as const;
  const userOpHash = `0x${"44".repeat(32)}` as Hex;
  const signature = await user.signMessage({ message: { raw: userOpHash } });
  const rawSignature = await user.sign({ hash: userOpHash });
  let broadcast = false;
  const publicClient = {
    getGasPrice: async () => 1n,
    getTransactionCount: async () => 0,
    getChainId: async () => 10143,
    getCode: async () => kernelCode,
    readContract: async (input: { functionName: string }) => {
      if (input.functionName === "getNonce") return nonce;
      if (input.functionName === "getPair") return book;
      return userOpHash;
    },
    call: async () => undefined,
    request: async () => ({}),
  };
  const walletClient = rawBroadcastWallet(sponsor, () => {
    broadcast = true;
  });
  const result = await submitDirectUserOperation({
    calls: [{ to: book, data: signedOrderData }],
    operation,
    signature,
    publicClient,
    walletClient,
  });
  assert.equal(result.hash, `0x${"55".repeat(32)}`);
  assert.ok(result.timing.validationWallMs >= 0);
  assert.ok(result.timing.simulationMs >= 0);
  assert.ok(result.timing.broadcastMs >= 0);
  assert.ok(result.timing.broadcastPrepareMs >= 0);
  assert.ok(result.timing.sponsorSignMs >= 0);
  assert.ok(result.timing.rpcSubmissionMs >= 0);
  assert.ok(result.timing.nonceMs >= 0);
  assert.ok(result.timing.orderBookMs >= 0);
  assert.equal(broadcast, true);
  await assert.rejects(
    () =>
      submitDirectUserOperation({
        calls: [{ to: book, data: signedOrderData }],
        operation,
        signature: rawSignature,
        publicClient,
        walletClient,
      }),
    /signature does not match operation.sender/,
  );
  await assert.rejects(
    () =>
      submitDirectUserOperation({
        calls: [{ to: book, data: orderDataFor(user.address, 1n) }],
        operation,
        signature,
        publicClient,
        walletClient,
      }),
    /callData does not match calls exactly/,
  );
});

test("Kernel permission signatures are validated by EntryPoint preflight instead of EOA recovery", async () => {
  const user = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
  const sponsor = privateKeyToAccount("0x3333333333333333333333333333333333333333333333333333333333333333");
  const signedOrderData = orderDataFor(user.address);
  const permissionNonceKey = BigInt(`0x0102${"00".repeat(16)}112233440000`);
  const nonce = (permissionNonceKey << 64n) + 7n;
  const operation = {
    sender: user.address,
    nonce: `0x${nonce.toString(16)}`,
    initCode: "0x",
    callData: encodeKernelSingleCall(book, signedOrderData),
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  } as const;
  const pluginSignature = `0x${"ab".repeat(256)}` as Hex;
  let simulatedSignature: Hex | undefined;
  let broadcast = false;
  const publicClient = {
    getGasPrice: async () => 1n,
    getTransactionCount: async () => 0,
    getChainId: async () => 10_143,
    getCode: async () => kernelCode,
    readContract: async (input: { functionName: string }) => {
      if (input.functionName === "getNonce") return nonce;
      if (input.functionName === "getPair") return book;
      return `0x${"44".repeat(32)}`;
    },
    call: async (input: { data: Hex }) => {
      simulatedSignature = input.data.includes(pluginSignature.slice(2)) ? pluginSignature : undefined;
    },
  };
  const walletClient = rawBroadcastWallet(sponsor, () => {
    broadcast = true;
  });

  const result = await submitDirectUserOperation({
    calls: [{ to: book, data: signedOrderData }],
    operation,
    signature: pluginSignature,
    signatureMode: "kernel-permission",
    publicClient,
    walletClient,
  });

  assert.equal(simulatedSignature, pluginSignature);
  assert.equal(result.hash, `0x${"55".repeat(32)}`);
  assert.equal(broadcast, true);
});

test("rejects unknown signature modes and oversized Kernel permission envelopes", async () => {
  const user = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
  const operation = {
    sender: user.address,
    nonce: "0x10000000000000001",
    initCode: "0x",
    callData: "0x",
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  } as const;

  await assert.rejects(
    submitDirectUserOperation({
      calls: [],
      operation,
      signature: `0x${"ab".repeat(65)}`,
      signatureMode: "unknown",
    }),
    /signatureMode must be root or kernel-permission/,
  );
  await assert.rejects(
    submitDirectUserOperation({
      calls: [],
      operation,
      signature: `0x${"ab".repeat(16_385)}`,
      signatureMode: "kernel-permission",
    }),
    /Kernel permission signature is too large/,
  );
});

test("simulates the exact fixed-gas transaction once before broadcast", async () => {
  const user = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
  const sponsor = privateKeyToAccount("0x3333333333333333333333333333333333333333333333333333333333333333");
  const signedOrderData = orderDataFor(user.address);
  const nonce = (1n << 64n) + 7n;
  const operation = {
    sender: user.address,
    nonce: `0x${nonce.toString(16)}`,
    initCode: "0x",
    callData: encodeKernelSingleCall(book, signedOrderData),
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  } as const;
  const signature = await user.signMessage({ message: { raw: `0x${"44".repeat(32)}` as Hex } });
  let broadcast = false;
  let simulationCount = 0;
  let estimateCount = 0;
  let resolveSimulation: () => void = () => undefined;
  const preflightStarted: string[] = [];
  const publicClient = {
    getGasPrice: async () => 1n,
    getTransactionCount: async () => 0,
    getChainId: async () => 10143,
    getCode: async () => kernelCode,
    readContract: async (input: { functionName: string }) => {
      if (input.functionName === "getNonce") return nonce;
      if (input.functionName === "getPair") return book;
      return `0x${"44".repeat(32)}`;
    },
    estimateGas: async () => {
      estimateCount += 1;
      throw new Error("eth_estimateGas must not run");
    },
    call: async (input: { gas: bigint }) => {
      simulationCount += 1;
      preflightStarted.push("call");
      assert.equal(input.gas, MAX_OUTER_GAS_LIMIT);
      return new Promise<void>((resolve) => {
        resolveSimulation = resolve;
      });
    },
    request: async () => {
      throw new Error("debug_traceCall must not run");
    },
  };
  let broadcastGas: bigint | undefined;
  const walletClient = rawBroadcastWallet(sponsor, ({ request }) => {
    broadcast = true;
    broadcastGas = request.gas;
  });
  const submission = submitDirectUserOperation({
    calls: [{ to: book, data: signedOrderData }],
    operation,
    signature,
    publicClient,
    walletClient,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedBeforeSimulationResolved = [...preflightStarted];
  resolveSimulation();
  const result = await submission;
  assert.equal(result.hash, `0x${"55".repeat(32)}`);
  assert.equal(simulationCount, 1);
  assert.equal(estimateCount, 0);
  assert.deepEqual(startedBeforeSimulationResolved, ["call"]);
  assert.equal(broadcastGas, MAX_OUTER_GAS_LIMIT);
  assert.equal(broadcast, true);
  assert.match(directUserOpSource, /method: "eth_sendRawTransaction"/);
  assert.doesNotMatch(directUserOpSource, /walletClient\.sendTransaction/);
  assert.doesNotMatch(directUserOpSource, /prepareTransactionRequest/);
});

test("starts independent submit validation reads in parallel", async () => {
  const user = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");
  const sponsor = privateKeyToAccount("0x3333333333333333333333333333333333333333333333333333333333333333");
  const signedOrderData = orderDataFor(user.address);
  const nonce = (1n << 64n) + 7n;
  const operation = {
    sender: user.address,
    nonce: `0x${nonce.toString(16)}`,
    initCode: "0x",
    callData: encodeKernelSingleCall(book, signedOrderData),
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  } as const;
  const userOpHash = `0x${"44".repeat(32)}` as Hex;
  const signature = await user.signMessage({ message: { raw: userOpHash } });
  let resolveChainId: (chainId: number) => void = () => undefined;
  const validationStarted: string[] = [];
  const publicClient = {
    getGasPrice: async () => {
      validationStarted.push("getGasPrice");
      return 1n;
    },
    getTransactionCount: async () => {
      validationStarted.push("getSponsorNonce");
      return 0;
    },
    getChainId: async () => {
      validationStarted.push("getChainId");
      return new Promise<number>((resolve) => {
        resolveChainId = resolve;
      });
    },
    getCode: async () => {
      validationStarted.push("getCode");
      return kernelCode;
    },
    readContract: async (input: { functionName: string }) => {
      validationStarted.push(input.functionName);
      if (input.functionName === "getNonce") return nonce;
      if (input.functionName === "getPair") return book;
      return userOpHash;
    },
    call: async () => {
      validationStarted.push("call");
    },
  };
  const walletClient = rawBroadcastWallet(sponsor);
  const submission = submitDirectUserOperation({
    calls: [{ to: book, data: signedOrderData }],
    operation,
    signature,
    publicClient,
    walletClient,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedBeforeChainIdResolved = [...validationStarted];
  resolveChainId(10_143);
  await submission;
  assert.deepEqual(startedBeforeChainIdResolved, [
    "getChainId",
    "getCode",
    "getPair",
    "getNonce",
    "getUserOpHash",
    "call",
    "getSponsorNonce",
    "getGasPrice",
  ]);
});

void ENTRY_POINT_V07;
