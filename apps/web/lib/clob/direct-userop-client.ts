import {
  type Address,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  hashMessage,
  isAddress,
  isHash,
  isHex,
  keccak256,
  toHex,
} from "viem";

import { type AtomicCall, encodeAtomicBatch } from "./atomic-batch.ts";
import type { TransactionMetrics } from "./types";

const ACCOUNT_NOT_DELEGATED_CODE = "ACCOUNT_NOT_DELEGATED";
const MONAD_TESTNET_CHAIN_ID = 10_143;
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const USEROP_CALL_GAS_LIMIT = 5_000_000n;
const USEROP_VERIFICATION_GAS_LIMIT = 1_500_000n;
const MAX_CALLDATA_BYTES = 4_096;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_ENTRY_POINT_NONCE_KEY = 1n << 192n;
const kernelAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "execMode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export type PackedUserOperation = {
  sender: Hex;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type DirectUserOperationResponse = {
  operation: PackedUserOperation;
  userOpHash: Hash;
  timing?: NonNullable<TransactionMetrics["prepareBreakdown"]>;
};

export type DirectUserOperationSubmitResponse = {
  hash: Hash;
  timing?: NonNullable<TransactionMetrics["submitBreakdown"]>;
};

export type DirectUserOperationSignatureMode = "root" | "kernel-permission";

export type DirectUserOperationResult = {
  hash: Hash;
  metrics: TransactionMetrics;
};

type DirectUserOperationCall = {
  to: Address;
  data?: Hex;
  value?: Hex;
};

type EthereumProvider = { request: (...args: never[]) => Promise<unknown> };

type RequestOptions = {
  accessToken: string;
  chainId: number;
  fetchFn?: typeof fetch;
};

export class DirectUserOperationError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DirectUserOperationError";
    this.code = code;
    this.status = status;
  }
}

export function isAccountNotDelegatedError(error: unknown): error is DirectUserOperationError {
  return error instanceof DirectUserOperationError && error.status === 409 && error.code === ACCOUNT_NOT_DELEGATED_CODE;
}

function assertMonad(chainId: number) {
  if (chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error("Direct UserOperations are only supported on Monad testnet");
  }
}

function serializeCalls(calls: readonly AtomicCall[]): DirectUserOperationCall[] {
  if (calls.length === 0) throw new Error("At least one wallet call is required");
  return calls.map(({ to, data, value }) => ({
    to,
    ...(data !== undefined ? { data } : {}),
    ...(value !== undefined ? { value: toHex(value) } : {}),
  }));
}

function assertHexField(value: unknown, field: string): asserts value is Hex {
  if (typeof value !== "string" || !isHex(value)) throw new Error(`Direct UserOperation ${field} must be hex encoded`);
}

function packUint128Pair(high: bigint, low: bigint): Hex {
  if (high < 0n || low < 0n || high > MAX_UINT128 || low > MAX_UINT128) {
    throw new Error("Packed UserOperation values must fit into uint128");
  }
  return concatHex([toHex(high, { size: 16 }), toHex(low, { size: 16 })]);
}

function encodeKernelCall(call: AtomicCall): Hex {
  const data = call.data ?? "0x";
  const value = call.value ?? 0n;
  if (!isAddress(call.to)) throw new Error("Every session call requires a valid target address");
  if (!isHex(data) || (data.length - 2) / 2 > MAX_CALLDATA_BYTES) {
    throw new Error("Session call data must be bounded hex");
  }
  if (value < 0n) throw new Error("Session call value cannot be negative");
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [`0x${"00".repeat(32)}`, concatHex([getAddress(call.to), toHex(value, { size: 32 }), data])],
  });
}

function localUserOpHash(operation: PackedUserOperation): Hash {
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
        getAddress(operation.sender),
        BigInt(operation.nonce),
        keccak256(operation.initCode),
        keccak256(operation.callData),
        operation.accountGasLimits,
        BigInt(operation.preVerificationGas),
        operation.gasFees,
        keccak256(operation.paymasterAndData),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [packedHash, ENTRY_POINT_V07, BigInt(MONAD_TESTNET_CHAIN_ID)],
    ),
  );
}

export function prepareLocalSessionUserOperation(input: {
  chainId: number;
  sender: Address;
  calls: readonly AtomicCall[];
  nonceKey: bigint;
  nonceSequence: bigint;
}): DirectUserOperationResponse {
  assertMonad(input.chainId);
  if (!isAddress(input.sender)) throw new Error("A valid UserOperation sender is required");
  const mode = Number(input.nonceKey >> 184n);
  const validatorType = Number((input.nonceKey >> 176n) & 0xffn);
  if (
    input.nonceKey <= 0n ||
    input.nonceKey >= MAX_ENTRY_POINT_NONCE_KEY ||
    (mode !== 0 && mode !== 1) ||
    validatorType !== 2
  ) {
    throw new Error("nonceKey must select a Kernel permission validator");
  }
  if (input.nonceSequence < 0n || input.nonceSequence > MAX_UINT64) {
    throw new Error("nonceSequence must fit into uint64");
  }
  if (input.calls.length === 0 || input.calls.length > 3) {
    throw new Error("calls must contain between 1 and 3 entries");
  }
  for (const call of input.calls) {
    if (!isAddress(call.to)) throw new Error("Every session call requires a valid target address");
    if (call.data !== undefined && (!isHex(call.data) || (call.data.length - 2) / 2 > MAX_CALLDATA_BYTES)) {
      throw new Error("Session call data must be bounded hex");
    }
    if ((call.value ?? 0n) < 0n) throw new Error("Session call value cannot be negative");
  }
  const callData = input.calls.length === 1 ? encodeKernelCall(input.calls[0]) : encodeAtomicBatch(input.calls);
  const operation: PackedUserOperation = {
    sender: getAddress(input.sender),
    nonce: toHex((input.nonceKey << 64n) | input.nonceSequence),
    initCode: "0x",
    callData,
    accountGasLimits: packUint128Pair(USEROP_VERIFICATION_GAS_LIMIT, USEROP_CALL_GAS_LIMIT),
    preVerificationGas: "0x0",
    gasFees: packUint128Pair(0n, 0n),
    paymasterAndData: "0x",
    signature: "0x",
  };
  return { operation, userOpHash: localUserOpHash(operation) };
}

function parseOperation(value: unknown): PackedUserOperation {
  if (!value || typeof value !== "object") throw new Error("Direct UserOperation response is missing operation");
  const operation = value as Partial<PackedUserOperation>;
  for (const field of [
    "sender",
    "nonce",
    "initCode",
    "callData",
    "accountGasLimits",
    "preVerificationGas",
    "gasFees",
    "paymasterAndData",
    "signature",
  ] as const) {
    assertHexField(operation[field], field);
  }
  if (typeof operation.sender !== "string" || !isAddress(operation.sender)) {
    throw new Error("Direct UserOperation sender must be an address");
  }
  if (operation.signature !== "0x") throw new Error("Prepared UserOperation must not contain a signature");
  return operation as PackedUserOperation;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Direct UserOperation request failed with status ${response.status}`;
    const code = typeof payload.code === "string" ? payload.code : undefined;
    throw new DirectUserOperationError(message, response.status, code);
  }
  if (!body || typeof body !== "object") throw new Error("Direct UserOperation response was not JSON");
  return body as Record<string, unknown>;
}

function requestOptions(options: RequestOptions) {
  assertMonad(options.chainId);
  if (!options.accessToken) throw new Error("A Privy access token is required for direct UserOperations");
  return { accessToken: options.accessToken, fetchFn: options.fetchFn ?? fetch };
}

function parsePrepareServerTiming(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const timing = value as Record<string, unknown>;
  const keys = [
    "authMs",
    "serverMs",
    "rpcWallMs",
    "chainIdMs",
    "delegationMs",
    "orderBookMs",
    "policyRpcMs",
    "nonceMs",
    "localMs",
  ] as const;
  for (const key of keys) {
    if (typeof timing[key] !== "number" || !Number.isFinite(timing[key]) || timing[key] < 0) return undefined;
  }
  return Object.fromEntries(keys.map((key) => [key, Math.round(timing[key] as number)])) as Pick<
    NonNullable<TransactionMetrics["prepareBreakdown"]>,
    (typeof keys)[number]
  >;
}

function parseSubmitServerTiming(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const timing = value as Record<string, unknown>;
  const keys = [
    "authMs",
    "serverMs",
    "validationWallMs",
    "chainIdMs",
    "delegationMs",
    "orderBookMs",
    "policyRpcMs",
    "nonceMs",
    "hashMs",
    "simulationMs",
    "broadcastMs",
    "broadcastPrepareMs",
    "sponsorNonceMs",
    "gasPriceMs",
    "sponsorSignMs",
    "rpcSubmissionMs",
  ] as const;
  for (const key of keys) {
    if (typeof timing[key] !== "number" || !Number.isFinite(timing[key]) || timing[key] < 0) return undefined;
  }
  return Object.fromEntries(keys.map((key) => [key, Math.round(timing[key] as number)])) as Pick<
    NonNullable<TransactionMetrics["submitBreakdown"]>,
    (typeof keys)[number]
  >;
}

export async function warmDirectUserOperationAuth(input: {
  chainId: number;
  accessToken: string;
  fetchFn?: typeof fetch;
}) {
  const { accessToken, fetchFn } = requestOptions(input);
  const startedAt = performance.now();
  const response = await fetchFn("/api/userops/auth", {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await readResponse(response);
  const serverAuthMs =
    typeof payload.authMs === "number" && Number.isFinite(payload.authMs) && payload.authMs >= 0
      ? Math.round(payload.authMs)
      : undefined;
  const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
  console.info("Sponsored UserOperation auth warm latency", { totalMs, serverAuthMs });
  return { totalMs, serverAuthMs };
}

export async function prepareDirectUserOperation(input: {
  chainId: number;
  sender: Address;
  calls: readonly AtomicCall[];
  accessToken: string;
  nonceKey?: bigint;
  nonceSequence?: bigint;
  fetchFn?: typeof fetch;
}): Promise<DirectUserOperationResponse> {
  if (!isAddress(input.sender)) throw new Error("A valid UserOperation sender is required");
  const { accessToken, fetchFn } = requestOptions(input);
  const fetchStartedAt = performance.now();
  const response = await fetchFn("/api/userops/prepare", {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: input.sender,
      calls: serializeCalls(input.calls),
      ...(input.nonceKey !== undefined ? { nonceKey: toHex(input.nonceKey) } : {}),
      ...(input.nonceSequence !== undefined ? { nonceSequence: toHex(input.nonceSequence) } : {}),
    }),
  });
  const responseStartedAt = performance.now();
  const payload = await readResponse(response);
  const responseMs = Math.max(0, Math.round(performance.now() - responseStartedAt));
  if (typeof payload.userOpHash !== "string" || !isHash(payload.userOpHash)) {
    throw new Error("Direct UserOperation response is missing a valid userOpHash");
  }
  const operation = parseOperation(payload.operation);
  if (operation.sender.toLowerCase() !== input.sender.toLowerCase()) {
    throw new Error("Prepared UserOperation sender did not match the connected wallet");
  }
  const serverTiming = parsePrepareServerTiming(payload.timing);
  const timing = serverTiming
    ? {
        ...serverTiming,
        // Fetch-to-headers contains both transport directions plus Next.js
        // framework overhead. Browser clocks cannot accurately split those
        // two network legs from a single HTTP request.
        networkMs: Math.max(0, Math.round(responseStartedAt - fetchStartedAt) - serverTiming.serverMs),
        responseMs,
      }
    : undefined;
  return { operation, userOpHash: payload.userOpHash as Hash, ...(timing ? { timing } : {}) };
}

export async function signDirectUserOperation(
  provider: EthereumProvider,
  userOpHash: Hash,
  sender: Address,
): Promise<Hex> {
  if (!isHash(userOpHash)) throw new Error("A valid UserOperation hash is required");
  if (!isAddress(sender)) throw new Error("A valid UserOperation signer is required");
  const request = provider.request as unknown as (args: {
    method: string;
    params?: readonly string[];
  }) => Promise<unknown>;
  // Privy's embedded-wallet provider exposes raw hash signing through
  // secp256k1_sign. Keep the provider as the receiver because its request
  // implementation reads wallet metadata (including address) from `this`.
  const signingHash = hashMessage({ raw: userOpHash });
  const result = await request.call(provider, { method: "secp256k1_sign", params: [signingHash] });
  if (typeof result !== "string" || !isHex(result) || result === "0x") {
    throw new Error("The embedded wallet returned an invalid UserOperation signature");
  }
  return result;
}

export async function submitDirectUserOperation(input: {
  chainId: number;
  calls: readonly AtomicCall[];
  operation: PackedUserOperation;
  signature: Hex;
  signatureMode?: DirectUserOperationSignatureMode;
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<DirectUserOperationSubmitResponse> {
  const { accessToken, fetchFn } = requestOptions(input);
  if (!isHex(input.signature) || input.signature === "0x") {
    throw new Error("A UserOperation signature is required");
  }
  const operation = parseOperation(input.operation);
  const fetchStartedAt = performance.now();
  const response = await fetchFn("/api/userops/submit", {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      calls: serializeCalls(input.calls),
      operation,
      signature: input.signature,
      signatureMode: input.signatureMode ?? "root",
    }),
  });
  const responseStartedAt = performance.now();
  const payload = await readResponse(response);
  const responseMs = Math.max(0, Math.round(performance.now() - responseStartedAt));
  if (typeof payload.hash !== "string" || !isHash(payload.hash)) {
    throw new Error("Direct UserOperation response is missing a valid transaction hash");
  }
  const serverTiming = parseSubmitServerTiming(payload.timing);
  const timing = serverTiming
    ? {
        ...serverTiming,
        networkMs: Math.max(0, Math.round(responseStartedAt - fetchStartedAt) - serverTiming.serverMs),
        responseMs,
      }
    : undefined;
  return { hash: payload.hash as Hash, ...(timing ? { timing } : {}) };
}

export async function submitDirectUserOperationWithWallet<T = never>(input: {
  accessToken: string;
  chainId: number;
  calls: readonly AtomicCall[];
  sender: Address;
  provider: EthereumProvider;
  onAccountNotDelegated?: () => Promise<T>;
  fetchFn?: typeof fetch;
}): Promise<DirectUserOperationResult | T> {
  const totalStartedAt = performance.now();
  const prepareStartedAt = performance.now();
  let prepared: DirectUserOperationResponse;
  try {
    prepared = await prepareDirectUserOperation({
      accessToken: input.accessToken,
      chainId: input.chainId,
      sender: input.sender,
      calls: input.calls,
      fetchFn: input.fetchFn,
    });
  } catch (error) {
    if (isAccountNotDelegatedError(error) && input.onAccountNotDelegated) return input.onAccountNotDelegated();
    throw error;
  }
  const prepareMs = Math.round(performance.now() - prepareStartedAt);

  const signStartedAt = performance.now();
  const signature = await signDirectUserOperation(input.provider, prepared.userOpHash, input.sender);
  const signMs = Math.round(performance.now() - signStartedAt);
  const submitStartedAt = performance.now();
  const submitted = await submitDirectUserOperation({
    accessToken: input.accessToken,
    chainId: input.chainId,
    calls: input.calls,
    operation: prepared.operation,
    signature,
    fetchFn: input.fetchFn,
  });
  const hash = submitted.hash;
  const submitMs = Math.round(performance.now() - submitStartedAt);
  const metrics = {
    prepareMs,
    prepareBreakdown: prepared.timing,
    signMs,
    submitMs,
    submitBreakdown: submitted.timing,
    totalMs: Math.round(performance.now() - totalStartedAt),
  };
  console.info("Direct UserOperation latency", { ...metrics, hash });
  return { hash, metrics };
}
