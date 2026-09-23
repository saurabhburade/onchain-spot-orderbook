// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import { randomBytes } from "node:crypto";

import { getAddress, isAddress } from "viem";
import { createDirectUserOperationPublicClient } from "./clients.ts";
import {
  DIRECT_USEROP_CHAIN_ID,
  DirectUserOperationError,
  type DirectUserOperationPrepareTiming,
  ENTRY_POINT_V07,
  elapsedMs,
  entryPointAbi,
  MAX_ENTRY_POINT_NONCE_KEY,
  MAX_UINT64,
  measure,
  type PublicClient,
} from "./constants.ts";
import { localUserOpHash } from "./hashing.ts";
import {
  assertDelegatedAccount,
  encodeAllowedCalls,
  encodedCalls,
  hexField,
  hexNumber,
  packUserOperation,
  parsedCalls,
  permissionNonceMode,
} from "./validation.ts";

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

  const publicClient: PublicClient = input.publicClient ?? createDirectUserOperationPublicClient();

  const timing = {
    chainIdMs: 0,
    delegationMs: 0,
    orderBookMs: 0,
    policyRpcMs: 0,
    nonceMs: 0,
    localValidationMs: 0,
  };
  const callTiming = { orderBookMs: 0, policyRpcMs: 0 };

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
