// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import {
  type Address,
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBigInt,
  isAddress,
  isHex,
  toHex,
  zeroAddress,
} from "viem";

import { clobAbi } from "../../../config/abis/clob.ts";
import { poolRegistryAbi } from "../../../config/abis/pool-registry.ts";
import { tokenFactoryAbi } from "../../../config/abis/token.ts";
import { type AtomicCall, encodeAtomicBatch } from "../atomic-batch.ts";
import {
  approveAbi,
  type CallValidationTiming,
  claimAbi,
  DirectUserOperationError,
  EIP7702_CODE,
  kernelAbi,
  MAX_CALLDATA_BYTES,
  MAX_ENTRY_POINT_NONCE_KEY,
  MAX_NONCE_KEY,
  MAX_UINT128,
  measure,
  monadContracts,
  type PackedUserOperation,
  type PublicClient,
  transferAbi,
  USEROP_CALL_GAS_LIMIT,
  USEROP_MAX_FEE_PER_GAS,
  USEROP_MAX_PRIORITY_FEE_PER_GAS,
  USEROP_PRE_VERIFICATION_GAS,
  USEROP_VERIFICATION_GAS_LIMIT,
} from "./constants.ts";

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

export function hexField(value: unknown, label: string, expectedBytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value)) {
    throw new DirectUserOperationError(`${label} must be a 0x-prefixed hex string`);
  }
  if (expectedBytes !== undefined && value.length !== 2 + expectedBytes * 2) {
    throw new DirectUserOperationError(`${label} must be exactly ${expectedBytes} bytes`);
  }
  return value as Hex;
}

export function hexNumber(value: Hex, label: string): bigint {
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

export function assertSafeUserOperationGas(operation: PackedUserOperation) {
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

export function permissionNonceMode(nonceKey: bigint) {
  const mode = Number(nonceKey >> 184n);
  const validatorType = Number((nonceKey >> 176n) & 0xffn);
  return { mode, validatorType };
}

export function assertSignatureModeNonceKey(nonceKey: bigint, signatureMode: "root" | "kernel-permission") {
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

export async function assertDelegatedAccount(publicClient: PublicClient, sender: Address) {
  const code = await publicClient.getCode({ address: sender });
  if (code?.toLowerCase() !== EIP7702_CODE) {
    throw new DirectUserOperationError(
      `${sender} is not delegated to the expected Kernel v3.3 implementation`,
      "ACCOUNT_NOT_DELEGATED",
      409,
    );
  }
}

function addressEqual(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function canonicalCall(abi: readonly unknown[], data: Hex) {
  const decoded = decodeFunctionData({ abi, data } as never);
  const canonical = encodeFunctionData({
    abi,
    functionName: decoded.functionName,
    args: decoded.args,
  } as never);
  return { ...decoded, canonical };
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

async function verifiedOrderCall(
  publicClient: PublicClient,
  sender: Address,
  call: AtomicCall,
  timing?: CallValidationTiming,
) {
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

export function parsedCalls(rawCalls: unknown): AtomicCall[] {
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

export function encodedCalls(calls: readonly AtomicCall[]) {
  const singleCall = calls.length === 1 ? calls[0] : undefined;
  return singleCall
    ? encodeKernelSingleCall(singleCall.to, singleCall.data ?? "0x", singleCall.value ?? 0n)
    : encodeAtomicBatch(calls);
}

async function validatedCalls(
  rawCalls: unknown,
  sender: Address,
  publicClient: PublicClient,
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
  publicClient: PublicClient,
  timing?: CallValidationTiming,
): Promise<{ calls: AtomicCall[]; callData: Hex }> {
  const calls = await validatedCalls(rawCalls, sender, publicClient, timing);
  return { calls, callData: encodedCalls(calls) };
}
