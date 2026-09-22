// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import { randomBytes } from "node:crypto";

import {
  type Address,
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  hashMessage,
  hexToBigInt,
  http,
  isAddress,
  isHash,
  isHex,
  keccak256,
  parseAbi,
  recoverAddress,
  toHex,
  zeroAddress,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

import { clobAbi } from "../../config/abis/clob.ts";
import { poolRegistryAbi } from "../../config/abis/pool-registry.ts";
import { tokenFactoryAbi } from "../../config/abis/token.ts";
import { MONAD_TESTNET_CHAIN_ID } from "../../config/constants.ts";
import { clobContractsByChainId } from "../../config/contracts.ts";
import { type AtomicCall, encodeAtomicBatch } from "./atomic-batch.ts";

export const DIRECT_USEROP_CHAIN_ID = MONAD_TESTNET_CHAIN_ID;
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
export const KERNEL_V33_DELEGATE = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28" as Address;
export const EIP7702_DELEGATION_PREFIX = "0xef0100";
export const ACCOUNT_NOT_DELEGATED = "ACCOUNT_NOT_DELEGATED" as const;

// These are deliberately fixed. UserOperations are zero-fee because the sponsor
// pays the outer EntryPoint transaction, and accepting client-selected gas values
// would make this endpoint an unnecessarily flexible gas-spending primitive.
export const USEROP_CALL_GAS_LIMIT = 5_000_000n;
// Permission enable mode installs policy/signer modules during validation and
// needs more headroom than the 65-byte root-validator path.
export const USEROP_VERIFICATION_GAS_LIMIT = 1_500_000n;
export const USEROP_PRE_VERIFICATION_GAS = 0n;
export const USEROP_MAX_FEE_PER_GAS = 0n;
export const USEROP_MAX_PRIORITY_FEE_PER_GAS = 0n;
export const MAX_OUTER_GAS_LIMIT = 8_000_000n;
export const MAX_CALLDATA_BYTES = 4_096;
export const MAX_KERNEL_PERMISSION_SIGNATURE_BYTES = 16_384;

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_NONCE_KEY = 1n << 176n;
const MAX_ENTRY_POINT_NONCE_KEY = 1n << 192n;
const EIP7702_CODE = `${EIP7702_DELEGATION_PREFIX}${KERNEL_V33_DELEGATE.slice(2)}`.toLowerCase();
const monadContracts = clobContractsByChainId[MONAD_TESTNET_CHAIN_ID];

function directRpcUrl() {
  return process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
}

function directChain() {
  return defineChain({
    ...monadTestnet,
    rpcUrls: { default: { http: [directRpcUrl()] } },
  });
}

function directTransport() {
  return http(directRpcUrl(), {
    batch: { batchSize: 10, wait: 0 },
    retryCount: 0,
  });
}

const entryPointAbi = parseAbi([
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address payable beneficiary)",
]);

const kernelAbi = parseAbi(["function execute(bytes32 execMode,bytes executionCalldata) payable"]);
const approveAbi = [
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
] as const;
const claimAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
] as const;
const transferAbi = [
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
] as const;

function canonicalCall(abi: readonly unknown[], data: Hex) {
  const decoded = decodeFunctionData({ abi, data } as never);
  const canonical = encodeFunctionData({
    abi,
    functionName: decoded.functionName,
    args: decoded.args,
  } as never);
  return { ...decoded, canonical };
}

export type PackedUserOperation = {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

type PublicClient = any;
type WalletClient = any;

export type DirectUserOperationClients = {
  publicClient: PublicClient;
  walletClient: WalletClient;
};

export type DirectUserOperationPrepareTiming = {
  rpcWallMs: number;
  chainIdMs: number;
  delegationMs: number;
  orderBookMs: number;
  policyRpcMs: number;
  nonceMs: number;
  localMs: number;
};

type CallValidationTiming = {
  orderBookMs: number;
  policyRpcMs: number;
};

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function measure<T>(task: () => Promise<T>, record: (durationMs: number) => void): Promise<T> {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    record(elapsedMs(startedAt));
  }
}

export class DirectUserOperationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "DIRECT_USEROP_ERROR", status = 400) {
    super(message);
    this.name = "DirectUserOperationError";
    this.code = code;
    this.status = status;
  }
}

export function packUint128Pair(high: bigint, low: bigint): Hex {
  if (high < 0n || low < 0n || high > MAX_UINT128 || low > MAX_UINT128) {
    throw new DirectUserOperationError("Packed UserOperation values must fit into uint128");
  }
  return concatHex([toHex(high, { size: 16 }), toHex(low, { size: 16 })]);
}

export function encodeKernelSingleCall(target: Address, data: Hex, value = 0n): Hex {
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [`0x${"00".repeat(32)}`, concatHex([getAddress(target), toHex(value, { size: 32 }), data])],
  });
}

function bodyRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DirectUserOperationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new DirectUserOperationError(`${label} contains an unsupported field: ${key}`);
  }
}

function hexField(value: unknown, label: string, expectedBytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value)) {
    throw new DirectUserOperationError(`${label} must be a 0x-prefixed hex string`);
  }
  if (expectedBytes !== undefined && value.length !== 2 + expectedBytes * 2) {
    throw new DirectUserOperationError(`${label} must be exactly ${expectedBytes} bytes`);
  }
  return value as Hex;
}

function hexNumber(value: Hex, label: string): bigint {
  try {
    return hexToBigInt(value);
  } catch {
    throw new DirectUserOperationError(`${label} must be a valid hex integer`);
  }
}

export function parsePackedUserOperation(value: unknown, requireUnsignedSignature = false): PackedUserOperation {
  const body = bodyRecord(value, "operation");
  rejectUnknownKeys(
    body,
    [
      "sender",
      "nonce",
      "initCode",
      "callData",
      "accountGasLimits",
      "preVerificationGas",
      "gasFees",
      "paymasterAndData",
      "signature",
    ],
    "operation",
  );

  if (typeof body.sender !== "string" || !isAddress(body.sender)) {
    throw new DirectUserOperationError("operation.sender must be a valid address");
  }
  const operation: PackedUserOperation = {
    sender: getAddress(body.sender),
    nonce: hexField(body.nonce, "operation.nonce"),
    initCode: hexField(body.initCode, "operation.initCode"),
    callData: hexField(body.callData, "operation.callData"),
    accountGasLimits: hexField(body.accountGasLimits, "operation.accountGasLimits", 32),
    preVerificationGas: hexField(body.preVerificationGas, "operation.preVerificationGas"),
    gasFees: hexField(body.gasFees, "operation.gasFees", 32),
    paymasterAndData: hexField(body.paymasterAndData, "operation.paymasterAndData"),
    signature: hexField(body.signature, "operation.signature"),
  };
  if (requireUnsignedSignature && operation.signature.toLowerCase() !== "0x") {
    throw new DirectUserOperationError("operation.signature must be 0x before user signing");
  }
  if (operation.initCode.toLowerCase() !== "0x") {
    throw new DirectUserOperationError("initCode is not permitted for delegated accounts");
  }
  if (operation.paymasterAndData.toLowerCase() !== "0x") {
    throw new DirectUserOperationError("paymasterAndData is not permitted");
  }
  if ((operation.callData.length - 2) / 2 > MAX_CALLDATA_BYTES) {
    throw new DirectUserOperationError("operation.callData is too large");
  }
  return operation;
}

function decodePackedPair(value: Hex, label: string): [bigint, bigint] {
  try {
    const packed = hexToBigInt(value);
    return [packed >> 128n, packed & MAX_UINT128];
  } catch {
    throw new DirectUserOperationError(`${label} is not a valid packed uint128 pair`);
  }
}

function assertSafeUserOperationGas(operation: PackedUserOperation) {
  const [verificationGasLimit, callGasLimit] = decodePackedPair(operation.accountGasLimits, "accountGasLimits");
  const [maxPriorityFeePerGas, maxFeePerGas] = decodePackedPair(operation.gasFees, "gasFees");
  const preVerificationGas = hexNumber(operation.preVerificationGas, "preVerificationGas");
  const nonce = hexNumber(operation.nonce, "nonce");
  const nonceKey = nonce >> 64n;

  if (callGasLimit !== USEROP_CALL_GAS_LIMIT || verificationGasLimit !== USEROP_VERIFICATION_GAS_LIMIT) {
    throw new DirectUserOperationError("UserOperation gas limits do not match the server policy");
  }
  if (preVerificationGas !== USEROP_PRE_VERIFICATION_GAS) {
    throw new DirectUserOperationError("UserOperation preVerificationGas does not match the server policy");
  }
  if (maxFeePerGas !== USEROP_MAX_FEE_PER_GAS || maxPriorityFeePerGas !== USEROP_MAX_PRIORITY_FEE_PER_GAS) {
    throw new DirectUserOperationError("UserOperation gas fees must be zero");
  }
  if (nonceKey <= 0n || nonceKey >= MAX_ENTRY_POINT_NONCE_KEY) {
    throw new DirectUserOperationError("UserOperation nonce key is outside the permitted range");
  }
}

function permissionNonceMode(nonceKey: bigint) {
  const mode = Number(nonceKey >> 184n);
  const validatorType = Number((nonceKey >> 176n) & 0xffn);
  return { mode, validatorType };
}

function assertSignatureModeNonceKey(nonceKey: bigint, signatureMode: "root" | "kernel-permission") {
  const { mode, validatorType } = permissionNonceMode(nonceKey);
  if (signatureMode === "root") {
    if (mode !== 0 || validatorType !== 0 || nonceKey >= MAX_NONCE_KEY) {
      throw new DirectUserOperationError("Root signature requires a root-validator nonce key");
    }
    return;
  }
  if ((mode !== 0 && mode !== 1) || validatorType !== 2) {
    throw new DirectUserOperationError("Kernel permission signature requires a permission-validator nonce key");
  }
}

export function packUserOperation(input: {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  signature?: Hex;
}): PackedUserOperation {
  return {
    sender: getAddress(input.sender),
    nonce: toHex(input.nonce),
    initCode: "0x",
    callData: input.callData,
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: toHex(USEROP_PRE_VERIFICATION_GAS),
    gasFees: packUint128Pair(USEROP_MAX_PRIORITY_FEE_PER_GAS, USEROP_MAX_FEE_PER_GAS),
    paymasterAndData: "0x",
    signature: input.signature ?? "0x",
  };
}

function expectedDelegationCode() {
  return EIP7702_CODE;
}

export async function assertDelegatedAccount(publicClient: any, sender: Address) {
  const code = await publicClient.getCode({ address: sender });
  if (code?.toLowerCase() !== expectedDelegationCode()) {
    throw new DirectUserOperationError(
      `${sender} is not delegated to the expected Kernel v3.3 implementation`,
      ACCOUNT_NOT_DELEGATED,
      409,
    );
  }
}

function addressEqual(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalFunctionCall(data: Hex): { functionName: string; args: readonly unknown[]; data: Hex } {
  const decoded = decodeFunctionData({ abi: clobAbi, data });
  const canonical = encodeFunctionData({
    abi: clobAbi,
    functionName: decoded.functionName,
    args: decoded.args,
  } as never);
  return { functionName: decoded.functionName, args: decoded.args, data: canonical };
}

async function verifiedOrderCall(publicClient: any, sender: Address, call: AtomicCall, timing?: CallValidationTiming) {
  if (!call.data) throw new DirectUserOperationError("Every CLOB call must contain calldata");
  let decoded: { functionName: string; args: readonly unknown[]; data: Hex };
  try {
    decoded = canonicalFunctionCall(call.data);
  } catch {
    throw new DirectUserOperationError("CLOB calldata is not a supported function call");
  }
  if (decoded.data.toLowerCase() !== call.data.toLowerCase()) {
    throw new DirectUserOperationError("CLOB calldata is not canonically encoded");
  }

  let assets: [Address, Address];
  if (decoded.functionName === "placeLimitOrderWithMaxBookSteps" || decoded.functionName === "executeMarketOrder") {
    const [request] = decoded.args as [{ trader: Address; baseAsset: Address; quoteAsset: Address }];
    if (!request || !addressEqual(request.trader, sender)) {
      throw new DirectUserOperationError("CLOB order trader must match operation.sender");
    }
    assets = [getAddress(request.baseAsset), getAddress(request.quoteAsset)];
  } else if (decoded.functionName === "cancelOrder") {
    const [orderId] = decoded.args as [Hex];
    const result = await measure(
      () =>
        publicClient.readContract({
          address: call.to,
          abi: clobAbi,
          functionName: "getOrder",
          args: [orderId],
        }),
      (durationMs) => {
        if (timing) timing.policyRpcMs += durationMs;
      },
    );
    const order = (result as [{ trader: Address; baseAsset: Address; quoteAsset: Address }])[0];
    if (!order || !addressEqual(order.trader, sender)) {
      throw new DirectUserOperationError("Only the order owner may cancel a CLOB order");
    }
    assets = [getAddress(order.baseAsset), getAddress(order.quoteAsset)];
  } else {
    throw new DirectUserOperationError("CLOB function is not allowlisted");
  }

  if (!monadContracts.factoryAddress)
    throw new DirectUserOperationError("CLOB factory is not configured", "CLOB_CONFIG_MISSING", 503);
  const expectedBook = await measure(
    () =>
      publicClient.readContract({
        address: monadContracts.factoryAddress,
        abi: poolRegistryAbi,
        functionName: "getPair",
        args: assets,
      }) as Promise<Address>,
    (durationMs) => {
      if (timing) timing.orderBookMs += durationMs;
    },
  );
  if (!isAddress(expectedBook) || addressEqual(expectedBook, zeroAddress) || !addressEqual(expectedBook, call.to)) {
    throw new DirectUserOperationError("CLOB target is not the deployed book for the requested assets");
  }
  return { assets, book: getAddress(expectedBook) };
}

function parsedCalls(rawCalls: unknown): AtomicCall[] {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0 || rawCalls.length > 3) {
    throw new DirectUserOperationError("calls must contain between 1 and 3 entries");
  }
  return rawCalls.map((rawCall) => {
    const call = bodyRecord(rawCall, "Each call");
    rejectUnknownKeys(call, ["to", "data", "value"], "call");
    if (typeof call.to !== "string" || !isAddress(call.to)) {
      throw new DirectUserOperationError("Each wallet call requires a valid target address");
    }
    const data = call.data === undefined ? "0x" : hexField(call.data, "call.data");
    if ((data.length - 2) / 2 > MAX_CALLDATA_BYTES) {
      throw new DirectUserOperationError("Call calldata is too large");
    }
    const value = call.value === undefined ? 0n : hexNumber(hexField(call.value, "call.value"), "call.value");
    return { to: getAddress(call.to), data, value } satisfies AtomicCall;
  });
}

function encodedCalls(calls: readonly AtomicCall[]) {
  const singleCall = calls.length === 1 ? calls[0] : undefined;
  return singleCall
    ? encodeKernelSingleCall(singleCall.to, singleCall.data ?? "0x", singleCall.value ?? 0n)
    : encodeAtomicBatch(calls);
}

async function validatedCalls(
  rawCalls: unknown,
  sender: Address,
  publicClient: any,
  timing?: CallValidationTiming,
): Promise<AtomicCall[]> {
  const calls = parsedCalls(rawCalls);
  try {
    const selector = calls[0]?.data?.slice(0, 10).toLowerCase();
    const singleCall = calls.length === 1 ? calls[0] : undefined;

    if (singleCall?.data === "0x") {
      if (!singleCall.value || singleCall.value <= 0n) {
        throw new DirectUserOperationError("A native transfer must include a positive value");
      }
      return calls;
    }

    let isFaucetClaim = false;
    if (singleCall && monadContracts.faucetAddress && addressEqual(singleCall.to, monadContracts.faucetAddress)) {
      try {
        decodeFunctionData({ abi: claimAbi, data: singleCall.data ?? "0x" });
        isFaucetClaim = true;
      } catch {
        // The target is checked again below and malformed calldata is rejected.
      }
    }
    if (singleCall && isFaucetClaim) {
      if (singleCall.value !== 0n) throw new DirectUserOperationError("Faucet claims cannot transfer native value");
      const decoded = canonicalCall(claimAbi, singleCall.data ?? "0x");
      const [token] = decoded.args as readonly [Address];
      if (!monadContracts.faucetTokens.some((allowed) => addressEqual(allowed.address, token))) {
        throw new DirectUserOperationError("The faucet token is not allowlisted");
      }
      if (decoded.canonical.toLowerCase() !== singleCall.data?.toLowerCase()) {
        throw new DirectUserOperationError("Faucet calldata is not canonically encoded");
      }
      return calls;
    }

    if (singleCall && selector === "0xa9059cbb") {
      if (singleCall.value !== 0n) throw new DirectUserOperationError("ERC-20 transfers cannot include native value");
      let decoded: { args: readonly [Address, bigint]; canonical: Hex };
      try {
        decoded = canonicalCall(transferAbi, singleCall.data ?? "0x") as unknown as typeof decoded;
      } catch {
        throw new DirectUserOperationError("Withdrawal calldata is not canonically encoded");
      }
      if (decoded.args[1] <= 0n || decoded.canonical.toLowerCase() !== singleCall.data?.toLowerCase()) {
        throw new DirectUserOperationError("Withdrawal calldata is not canonically encoded");
      }
      return calls;
    }

    if (
      singleCall &&
      monadContracts.tokenFactoryAddress &&
      addressEqual(singleCall.to, monadContracts.tokenFactoryAddress)
    ) {
      if (singleCall.value !== 0n) throw new DirectUserOperationError("Token deployment cannot include native value");
      let decoded: ReturnType<typeof canonicalCall>;
      try {
        decoded = canonicalCall(tokenFactoryAbi, singleCall.data ?? "0x");
      } catch {
        throw new DirectUserOperationError("Token deployment calldata is not supported");
      }
      if (
        decoded.functionName !== "createToken" ||
        decoded.canonical.toLowerCase() !== singleCall.data?.toLowerCase()
      ) {
        throw new DirectUserOperationError("Token deployment calldata is not canonically encoded");
      }
      const [name, symbol] = decoded.args as readonly [string, string];
      if (!name?.trim() || !symbol?.trim()) throw new DirectUserOperationError("Token name and symbol are required");
      return calls;
    }

    if (singleCall && monadContracts.factoryAddress && addressEqual(singleCall.to, monadContracts.factoryAddress)) {
      let decoded: ReturnType<typeof canonicalCall>;
      try {
        decoded = canonicalCall(poolRegistryAbi, singleCall.data ?? "0x");
      } catch {
        throw new DirectUserOperationError("Market creation calldata is not supported");
      }
      if (decoded.functionName !== "createPair" || decoded.canonical.toLowerCase() !== singleCall.data?.toLowerCase()) {
        throw new DirectUserOperationError("Market creation calldata is not canonically encoded");
      }
      const [baseAsset, quoteAsset] = decoded.args as readonly [Address, Address];
      if (!isAddress(baseAsset) || !isAddress(quoteAsset) || addressEqual(baseAsset, quoteAsset)) {
        throw new DirectUserOperationError("Market assets must be distinct valid addresses");
      }
      const creationFee = await measure(
        () =>
          publicClient.readContract({
            address: monadContracts.factoryAddress,
            abi: poolRegistryAbi,
            functionName: "marketCreationFee",
          }),
        (durationMs) => {
          if (timing) timing.policyRpcMs += durationMs;
        },
      );
      if (singleCall.value !== creationFee) {
        throw new DirectUserOperationError("Market creation value does not match the configured fee");
      }
      return calls;
    }

    if (calls.some((call) => (call.value ?? 0n) !== 0n)) {
      throw new DirectUserOperationError("CLOB order batches cannot transfer native value");
    }

    if (singleCall && monadContracts.faucetAddress && addressEqual(singleCall.to, monadContracts.faucetAddress)) {
      throw new DirectUserOperationError("Only the configured faucet claim is permitted for the faucet target");
    }

    const orderCalls = calls.filter((call) => {
      const selector = call.data?.slice(0, 10).toLowerCase();
      return selector !== "0x095ea7b3";
    });
    if (orderCalls.length === 0) throw new DirectUserOperationError("Approval-only batches are not permitted");
    if (orderCalls.length !== 1) throw new DirectUserOperationError("A batch may contain only one CLOB order call");
    const orderCall = orderCalls[0];
    if (!orderCall) throw new DirectUserOperationError("A CLOB order call is required");
    const { assets, book } = await verifiedOrderCall(publicClient, sender, orderCall, timing);
    for (const call of calls) {
      if (call === orderCall) continue;
      if (!call.data) throw new DirectUserOperationError("Approval calldata is required");
      let decoded: { args: readonly [Address, bigint] };
      try {
        decoded = decodeFunctionData({ abi: approveAbi, data: call.data });
      } catch {
        throw new DirectUserOperationError("Only canonical approvals may accompany a CLOB order");
      }
      const canonical = encodeFunctionData({ abi: approveAbi, functionName: "approve", args: decoded.args });
      if (canonical.toLowerCase() !== call.data.toLowerCase()) {
        throw new DirectUserOperationError("Approval calldata is not canonically encoded");
      }
      const [spender] = decoded.args;
      if (!addressEqual(spender, book) || !assets.some((asset) => addressEqual(asset, call.to))) {
        throw new DirectUserOperationError("Approvals must target the order assets and verified book");
      }
    }
    return calls;
  } catch (error) {
    if (error instanceof DirectUserOperationError) throw error;
    throw new DirectUserOperationError(error instanceof Error ? error.message : "Calls are not permitted");
  }
}

export async function encodeAllowedCalls(
  rawCalls: unknown,
  sender: Address,
  publicClient: any,
  timing?: CallValidationTiming,
): Promise<{ calls: AtomicCall[]; callData: Hex }> {
  const calls = await validatedCalls(rawCalls, sender, publicClient, timing);
  return { calls, callData: encodedCalls(calls) };
}

function userOpHash(publicClient: any, operation: PackedUserOperation) {
  return publicClient.readContract({
    address: ENTRY_POINT_V07,
    abi: entryPointAbi,
    functionName: "getUserOpHash",
    args: [contractPackedOperation(operation)],
  }) as Promise<Hex>;
}

/**
 * EntryPoint v0.7's getUserOpHash is deterministic, so preparation can hash
 * locally and avoid one full RPC round-trip. Submission still recomputes the
 * hash through the deployed EntryPoint before accepting the signature.
 */
export function localUserOpHash(operation: PackedUserOperation): Hex {
  const packedHash = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        operation.sender,
        hexNumber(operation.nonce, "nonce"),
        keccak256(operation.initCode),
        keccak256(operation.callData),
        operation.accountGasLimits,
        hexNumber(operation.preVerificationGas, "preVerificationGas"),
        operation.gasFees,
        keccak256(operation.paymasterAndData),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [packedHash, ENTRY_POINT_V07, BigInt(DIRECT_USEROP_CHAIN_ID)],
    ),
  );
}

function contractPackedOperation(operation: PackedUserOperation) {
  return {
    ...operation,
    nonce: hexNumber(operation.nonce, "nonce"),
    preVerificationGas: hexNumber(operation.preVerificationGas, "preVerificationGas"),
  };
}

function sponsorPrivateKey() {
  const value = process.env.SPONSER_PK;
  if (!value) throw new DirectUserOperationError("SPONSER_PK is not configured", "SPONSOR_KEY_MISSING", 503);
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DirectUserOperationError("SPONSER_PK must be a 32-byte hex private key", "SPONSOR_KEY_INVALID", 503);
  }
  return key as Hex;
}

export function createDirectUserOperationClients(): DirectUserOperationClients {
  const sponsor = privateKeyToAccount(sponsorPrivateKey(), { nonceManager });
  const chain = directChain();
  const transport = directTransport();
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account: sponsor, chain, transport }),
  };
}

export function createDirectUserOperationPublicClient() {
  return createPublicClient({ chain: directChain(), transport: directTransport() });
}

function sponsorAddress(walletClient: any): Address {
  const address = walletClient.account?.address;
  if (!address || !isAddress(address))
    throw new DirectUserOperationError("Sponsor account is not configured", "SPONSOR_KEY_INVALID", 503);
  return getAddress(address);
}

export async function prepareDirectUserOperation(input: {
  sender: unknown;
  calls: unknown;
  nonceKey?: unknown;
  nonceSequence?: unknown;
  publicClient?: any;
}) {
  if (typeof input.sender !== "string" || !isAddress(input.sender)) {
    throw new DirectUserOperationError("sender must be a valid address");
  }
  const sender = getAddress(input.sender);
  let nonceKey: bigint;
  if (input.nonceKey === undefined) {
    nonceKey = BigInt(`0x0000${randomBytes(22).toString("hex")}`);
  } else {
    const rawNonceKey = hexField(input.nonceKey, "nonceKey");
    nonceKey = hexNumber(rawNonceKey, "nonceKey");
    const { mode, validatorType } = permissionNonceMode(nonceKey);
    if (nonceKey <= 0n || nonceKey >= MAX_ENTRY_POINT_NONCE_KEY || (mode !== 0 && mode !== 1) || validatorType !== 2) {
      throw new DirectUserOperationError("nonceKey must select a Kernel permission validator");
    }
  }

  if (input.nonceSequence !== undefined) {
    if (input.nonceKey === undefined) {
      throw new DirectUserOperationError("nonceSequence requires an explicit Kernel permission nonceKey");
    }
    const nonceSequence = hexNumber(hexField(input.nonceSequence, "nonceSequence"), "nonceSequence");
    if (nonceSequence < 0n || nonceSequence > MAX_UINT64) {
      throw new DirectUserOperationError("nonceSequence must fit into uint64");
    }
    const localStartedAt = performance.now();
    const calls = parsedCalls(input.calls);
    const operation = packUserOperation({
      sender,
      nonce: (nonceKey << 64n) | nonceSequence,
      callData: encodedCalls(calls),
    });
    const hash = localUserOpHash(operation);
    return {
      operation,
      userOpHash: hash,
      timing: {
        rpcWallMs: 0,
        chainIdMs: 0,
        delegationMs: 0,
        orderBookMs: 0,
        policyRpcMs: 0,
        nonceMs: 0,
        localMs: elapsedMs(localStartedAt),
      } satisfies DirectUserOperationPrepareTiming,
    };
  }

  const publicClient = input.publicClient ?? createDirectUserOperationPublicClient();

  const timing = {
    chainIdMs: 0,
    delegationMs: 0,
    orderBookMs: 0,
    policyRpcMs: 0,
    nonceMs: 0,
    localValidationMs: 0,
  };
  const callTiming: CallValidationTiming = { orderBookMs: 0, policyRpcMs: 0 };

  // These reads are independent. Starting them together lets the HTTP
  // transport batch them and removes serialized network round-trips. Each
  // branch is timed independently, so the values intentionally overlap.
  const rpcStartedAt = performance.now();
  const [chainId, , allowedCalls, nonce] = await Promise.all([
    measure(
      () => publicClient.getChainId(),
      (durationMs) => (timing.chainIdMs = durationMs),
    ),
    measure(
      () => assertDelegatedAccount(publicClient, sender),
      (durationMs) => (timing.delegationMs = durationMs),
    ),
    measure(
      () => encodeAllowedCalls(input.calls, sender, publicClient, callTiming),
      (durationMs) => {
        timing.orderBookMs = callTiming.orderBookMs;
        timing.policyRpcMs = callTiming.policyRpcMs;
        timing.localValidationMs = Math.max(0, durationMs - callTiming.orderBookMs - callTiming.policyRpcMs);
      },
    ),
    measure(
      () =>
        publicClient.readContract({
          address: ENTRY_POINT_V07,
          abi: entryPointAbi,
          functionName: "getNonce",
          args: [sender, nonceKey],
        }) as Promise<bigint>,
      (durationMs) => (timing.nonceMs = durationMs),
    ),
  ]);
  const rpcWallMs = elapsedMs(rpcStartedAt);
  if (chainId !== DIRECT_USEROP_CHAIN_ID) {
    throw new DirectUserOperationError(
      "Direct UserOperations are only supported on Monad testnet",
      "UNSUPPORTED_CHAIN",
      400,
    );
  }
  const buildStartedAt = performance.now();
  const operation = packUserOperation({ sender, nonce, callData: allowedCalls.callData });
  const hash = localUserOpHash(operation);
  const buildHashMs = elapsedMs(buildStartedAt);
  return {
    operation,
    userOpHash: hash,
    timing: {
      rpcWallMs,
      chainIdMs: timing.chainIdMs,
      delegationMs: timing.delegationMs,
      orderBookMs: timing.orderBookMs,
      policyRpcMs: timing.policyRpcMs,
      nonceMs: timing.nonceMs,
      localMs: timing.localValidationMs + buildHashMs,
    } satisfies DirectUserOperationPrepareTiming,
  };
}

function handleOpsData(operation: PackedUserOperation, beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPointAbi,
    functionName: "handleOps",
    args: [[contractPackedOperation(operation)], beneficiary],
  });
}

function userOperationTransactionInput(walletClient: any, operation: PackedUserOperation) {
  return {
    data: handleOpsData(operation, sponsorAddress(walletClient)),
    outerGasLimit: MAX_OUTER_GAS_LIMIT,
  };
}

async function preflightUserOperation(
  publicClient: any,
  sponsor: Address,
  input: { data: Hex; outerGasLimit: bigint },
) {
  try {
    // Simulate the exact fixed-gas transaction that will be broadcast. This
    // validates the nonce, permission signature, policy, and target execution
    // without paying for a reverted sponsor transaction.
    await publicClient.call({
      account: sponsor,
      to: ENTRY_POINT_V07,
      data: input.data,
      gas: input.outerGasLimit,
    });
  } catch (error) {
    throw new DirectUserOperationError(
      `UserOperation simulation failed: ${error instanceof Error ? error.message : "unknown error"}`,
      "USEROP_PREFLIGHT_FAILED",
      400,
    );
  }
  return input;
}

type SponsorBroadcastTiming = {
  prepareMs: number;
  nonceMs: number;
  gasPriceMs: number;
  signMs: number;
  rpcMs: number;
};

type PreparedSponsorTransaction = {
  account: any;
  nonceManagerParameters?: { address: Address; chainId: number };
  request: {
    chainId: number;
    data: Hex;
    gas: bigint;
    gasPrice: bigint;
    nonce: number;
    to: Address;
    type: "legacy";
  };
};

function resetPreparedSponsorNonce(prepared: PreparedSponsorTransaction) {
  if (prepared.nonceManagerParameters) {
    prepared.account.nonceManager?.reset(prepared.nonceManagerParameters);
  }
}

async function prepareSponsorTransaction(
  publicClient: any,
  walletClient: any,
  input: { data: Hex; outerGasLimit: bigint },
  timing: SponsorBroadcastTiming,
): Promise<PreparedSponsorTransaction> {
  const account = walletClient.account;
  if (account?.type !== "local" || typeof account.signTransaction !== "function") {
    throw new DirectUserOperationError(
      "Sponsor account must support local transaction signing",
      "SPONSOR_KEY_INVALID",
      503,
    );
  }
  const chainId = walletClient.chain?.id ?? DIRECT_USEROP_CHAIN_ID;
  const nonceManagerParameters = account.nonceManager ? { address: account.address as Address, chainId } : undefined;
  const prepareStartedAt = performance.now();
  try {
    const [nonce, gasPrice] = (await Promise.all([
      measure<number>(
        () =>
          account.nonceManager
            ? account.nonceManager.consume({ address: account.address, chainId, client: walletClient })
            : publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
        (durationMs) => (timing.nonceMs = durationMs),
      ),
      measure<bigint>(
        () => publicClient.getGasPrice(),
        (durationMs) => (timing.gasPriceMs = durationMs),
      ),
    ])) as [number, bigint];
    timing.prepareMs = elapsedMs(prepareStartedAt);
    return {
      account,
      ...(nonceManagerParameters ? { nonceManagerParameters } : {}),
      request: {
        chainId,
        data: input.data,
        gas: input.outerGasLimit,
        gasPrice,
        nonce,
        to: ENTRY_POINT_V07,
        type: "legacy",
      },
    };
  } catch (error) {
    timing.prepareMs = elapsedMs(prepareStartedAt);
    if (nonceManagerParameters) account.nonceManager?.reset(nonceManagerParameters);
    throw error;
  }
}

async function signAndBroadcastSponsorTransaction(
  walletClient: any,
  prepared: PreparedSponsorTransaction,
  timing: SponsorBroadcastTiming,
) {
  try {
    const signedTransaction = await measure(
      () =>
        prepared.account.signTransaction(prepared.request, {
          serializer: walletClient.chain?.serializers?.transaction,
        }),
      (durationMs) => (timing.signMs = durationMs),
    );
    const hash = await measure(
      () =>
        walletClient.request({
          method: "eth_sendRawTransaction",
          params: [signedTransaction],
        }),
      (durationMs) => (timing.rpcMs = durationMs),
    );
    if (typeof hash !== "string" || !isHash(hash)) {
      throw new Error("eth_sendRawTransaction returned an invalid transaction hash");
    }
    return hash;
  } catch (error) {
    resetPreparedSponsorNonce(prepared);
    throw new DirectUserOperationError(
      `Sponsor could not broadcast the UserOperation: ${error instanceof Error ? error.message : "unknown error"}`,
      "SPONSOR_BROADCAST_FAILED",
      502,
    );
  }
}

export async function submitDirectUserOperation(input: {
  calls: unknown;
  operation: unknown;
  signature: unknown;
  signatureMode?: unknown;
  publicClient?: any;
  walletClient?: any;
}) {
  const signatureMode = input.signatureMode ?? "root";
  if (signatureMode !== "root" && signatureMode !== "kernel-permission") {
    throw new DirectUserOperationError("signatureMode must be root or kernel-permission");
  }
  if (typeof input.signature !== "string" || !isHex(input.signature) || input.signature === "0x") {
    throw new DirectUserOperationError("signature must be non-empty hex");
  }
  const signatureBytes = (input.signature.length - 2) / 2;
  if (signatureMode === "root" && signatureBytes !== 65) {
    throw new DirectUserOperationError("root signature must be a 65-byte secp256k1 signature");
  }
  if (signatureMode === "kernel-permission" && signatureBytes > MAX_KERNEL_PERMISSION_SIGNATURE_BYTES) {
    throw new DirectUserOperationError("Kernel permission signature is too large");
  }
  const unsignedOperation = parsePackedUserOperation(input.operation, true);
  assertSafeUserOperationGas(unsignedOperation);
  const clients =
    input.publicClient && input.walletClient
      ? { publicClient: input.publicClient, walletClient: input.walletClient }
      : createDirectUserOperationClients();
  const publicClient = clients.publicClient;
  const nonce = hexNumber(unsignedOperation.nonce, "nonce");
  const nonceKey = nonce >> 64n;
  assertSignatureModeNonceKey(nonceKey, signatureMode);
  const operation: PackedUserOperation = { ...unsignedOperation, signature: input.signature as Hex };
  const sponsor = sponsorAddress(clients.walletClient);
  const transactionInput = userOperationTransactionInput(clients.walletClient, operation);
  const timing = {
    chainIdMs: 0,
    delegationMs: 0,
    orderBookMs: 0,
    policyRpcMs: 0,
    nonceMs: 0,
    hashMs: 0,
    simulationMs: 0,
  };
  const callTiming: CallValidationTiming = { orderBookMs: 0, policyRpcMs: 0 };
  const validationStartedAt = performance.now();
  const validationReads = Promise.all([
    measure(
      () => publicClient.getChainId(),
      (durationMs) => (timing.chainIdMs = durationMs),
    ),
    measure(
      () => assertDelegatedAccount(publicClient, unsignedOperation.sender),
      (durationMs) => (timing.delegationMs = durationMs),
    ),
    measure(
      () => encodeAllowedCalls(input.calls, unsignedOperation.sender, publicClient, callTiming),
      () => {
        timing.orderBookMs = callTiming.orderBookMs;
        timing.policyRpcMs = callTiming.policyRpcMs;
      },
    ),
    measure(
      () =>
        publicClient.readContract({
          address: ENTRY_POINT_V07,
          abi: entryPointAbi,
          functionName: "getNonce",
          args: [unsignedOperation.sender, nonceKey],
        }) as Promise<bigint>,
      (durationMs) => (timing.nonceMs = durationMs),
    ),
    measure(
      () => userOpHash(publicClient, unsignedOperation),
      (durationMs) => (timing.hashMs = durationMs),
    ),
  ]);
  const broadcastTiming: SponsorBroadcastTiming = {
    prepareMs: 0,
    nonceMs: 0,
    gasPriceMs: 0,
    signMs: 0,
    rpcMs: 0,
  };
  const [validationResult, preflightResult, sponsorPreparationResult] = await Promise.allSettled([
    validationReads,
    measure(
      () => preflightUserOperation(publicClient, sponsor, transactionInput),
      (durationMs) => (timing.simulationMs = durationMs),
    ),
    prepareSponsorTransaction(publicClient, clients.walletClient, transactionInput, broadcastTiming),
  ]);
  const validationWallMs = elapsedMs(validationStartedAt);
  if (sponsorPreparationResult.status === "rejected") throw sponsorPreparationResult.reason;
  const preparedSponsor = sponsorPreparationResult.value;
  try {
    if (validationResult.status === "rejected") throw validationResult.reason;
    const [chainId, , allowedCalls, currentNonce, hash] = validationResult.value;
    if (chainId !== DIRECT_USEROP_CHAIN_ID) {
      throw new DirectUserOperationError(
        "Direct UserOperations are only supported on Monad testnet",
        "UNSUPPORTED_CHAIN",
        400,
      );
    }
    const { callData } = allowedCalls;
    if (unsignedOperation.callData.toLowerCase() !== callData.toLowerCase()) {
      throw new DirectUserOperationError("operation.callData does not match calls exactly");
    }
    if (currentNonce !== nonce)
      throw new DirectUserOperationError("UserOperation nonce is stale or already used", "NONCE_MISMATCH", 409);
    if (signatureMode === "root") {
      let recovered: Address;
      try {
        recovered = getAddress(
          await recoverAddress({ hash: hashMessage({ raw: hash }), signature: input.signature as Hex }),
        );
      } catch {
        throw new DirectUserOperationError("signature does not recover to the UserOperation sender");
      }
      if (recovered.toLowerCase() !== unsignedOperation.sender.toLowerCase()) {
        throw new DirectUserOperationError("signature does not match operation.sender");
      }
    }
    if (preflightResult.status === "rejected") throw preflightResult.reason;
  } catch (error) {
    resetPreparedSponsorNonce(preparedSponsor);
    throw error;
  }
  let broadcastMs = 0;
  const hashTransaction = await measure(
    () => signAndBroadcastSponsorTransaction(clients.walletClient, preparedSponsor, broadcastTiming),
    (durationMs) => (broadcastMs = durationMs),
  );
  return {
    hash: hashTransaction,
    timing: {
      validationWallMs,
      chainIdMs: timing.chainIdMs,
      delegationMs: timing.delegationMs,
      orderBookMs: timing.orderBookMs,
      policyRpcMs: timing.policyRpcMs,
      nonceMs: timing.nonceMs,
      hashMs: timing.hashMs,
      simulationMs: timing.simulationMs,
      broadcastMs,
      broadcastPrepareMs: broadcastTiming.prepareMs,
      sponsorNonceMs: broadcastTiming.nonceMs,
      gasPriceMs: broadcastTiming.gasPriceMs,
      sponsorSignMs: broadcastTiming.signMs,
      rpcSubmissionMs: broadcastTiming.rpcMs,
    },
  };
}
