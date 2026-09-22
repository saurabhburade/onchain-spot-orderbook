"use client";

import { type Address, type Hash, type Hex, hashTypedData, isHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { AtomicCall } from "./atomic-batch.ts";
import {
  type DirectUserOperationResult,
  type DirectUserOperationSubmitResponse,
  prepareLocalSessionUserOperation,
  submitDirectUserOperation,
} from "./direct-userop-client.ts";
import {
  createAppKernelPermissionConfiguration,
  encodeKernelV33PermissionEnableSignature,
  encodeKernelV33PermissionNonceKey,
  encodeKernelV33PermissionUserOpSignature,
  getKernelV33PermissionEnableTypedData,
  KERNEL_PERMISSION_MODE_DEFAULT,
  KERNEL_PERMISSION_MODE_ENABLE,
  MONAD_TESTNET_CHAIN_ID,
} from "./kernel-session-key.ts";

type EthereumProvider = { request: (...args: never[]) => Promise<unknown> };
type SessionPublicClient = {
  readContract: (input: never) => Promise<unknown>;
};

type SessionState = {
  owner: Address;
  privateKey: Hex;
  permissionId: Hex;
  validatorData: Hex;
  enableSignature: Hex;
  validUntil: number;
  enabled: boolean;
  nonceSequence: bigint;
};

const kernelNonceAbi = [
  {
    type: "function",
    name: "currentNonce",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
    stateMutability: "view",
  },
] as const;

const sessions = new Map<string, SessionState>();
const pendingSessions = new Map<string, Promise<SessionState>>();

function sessionId(chainId: number, owner: Address) {
  return `${chainId}:${owner.toLowerCase()}`;
}

function normalizeSignature(signature: unknown, label: string): Hex {
  if (typeof signature !== "string" || !isHex(signature) || (signature.length - 2) / 2 !== 65) {
    throw new Error(`${label} returned an invalid signature`);
  }
  const recovery = signature.slice(-2).toLowerCase();
  if (recovery === "00") return `${signature.slice(0, -2)}1b` as Hex;
  if (recovery === "01") return `${signature.slice(0, -2)}1c` as Hex;
  return signature as Hex;
}

async function rootSignHash(provider: EthereumProvider, digest: Hash): Promise<Hex> {
  const request = provider.request as unknown as (args: {
    method: string;
    params?: readonly string[];
  }) => Promise<unknown>;
  return normalizeSignature(
    await request.call(provider, { method: "secp256k1_sign", params: [digest] }),
    "Privy root signer",
  );
}

async function createSession(input: {
  chainId: number;
  owner: Address;
  provider: EthereumProvider;
  publicClient?: SessionPublicClient;
}): Promise<SessionState> {
  if (input.chainId !== MONAD_TESTNET_CHAIN_ID) {
    throw new Error("Kernel session keys are only supported on Monad testnet");
  }
  const privateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(privateKey);
  const now = Math.floor(Date.now() / 1_000);
  const permission = createAppKernelPermissionConfiguration({
    sessionKey: sessionAccount.address,
    validAfter: Math.max(0, now - 30),
  });
  const publicClient = input.publicClient ?? (await import("../../config/viem.ts")).getClobPublicClient(input.chainId);
  let enableNonce = 1;
  try {
    const currentNonce = (await publicClient.readContract({
      address: input.owner,
      abi: kernelNonceAbi,
      functionName: "currentNonce",
    } as never)) as bigint | number;
    enableNonce = Number(currentNonce === 0 || currentNonce === 0n ? 1 : currentNonce);
  } catch {
    // Kernel SDK uses one when metadata/nonce reads are unavailable.
  }
  const typedData = getKernelV33PermissionEnableTypedData({
    account: input.owner,
    chainId: input.chainId,
    permissionId: permission.permissionId,
    validatorData: permission.validatorData,
    nonce: enableNonce,
  });
  const enableSignature = await rootSignHash(input.provider, hashTypedData(typedData));
  return {
    owner: input.owner,
    privateKey,
    permissionId: permission.permissionId,
    validatorData: permission.validatorData,
    enableSignature,
    validUntil: permission.validUntil,
    enabled: false,
    nonceSequence: 0n,
  };
}

async function getOrCreateSession(input: {
  chainId: number;
  owner: Address;
  provider: EthereumProvider;
  publicClient?: SessionPublicClient;
}): Promise<{ session: SessionState; created: boolean }> {
  const key = sessionId(input.chainId, input.owner);
  const existing = sessions.get(key);
  const now = Math.floor(Date.now() / 1_000);
  if (existing && now < existing.validUntil) return { session: existing, created: false };
  sessions.delete(key);
  let pending = pendingSessions.get(key);
  if (!pending) {
    pending = createSession(input);
    pendingSessions.set(key, pending);
  }
  try {
    const session = await pending;
    sessions.set(key, session);
    return { session, created: true };
  } finally {
    pendingSessions.delete(key);
  }
}

async function getPreparedSession(chainId: number, owner: Address) {
  const key = sessionId(chainId, owner);
  const now = Math.floor(Date.now() / 1_000);
  const existing = sessions.get(key);
  if (existing && now < existing.validUntil) return existing;
  sessions.delete(key);

  // A trade may arrive while login-time authorization is still finishing. It
  // may await that existing work, but it must never initiate a Privy root
  // signature itself.
  const pending = pendingSessions.get(key);
  if (pending) {
    const session = await pending;
    if (Math.floor(Date.now() / 1_000) < session.validUntil) return session;
  }
  throw new Error("Your local signing session is not ready. Please wait for login setup and try again");
}

export function clearKernelSessionKey(chainId?: number, owner?: Address) {
  if (chainId !== undefined && owner) {
    sessions.delete(sessionId(chainId, owner));
    pendingSessions.delete(sessionId(chainId, owner));
    return;
  }
  sessions.clear();
  pendingSessions.clear();
}

/**
 * Starts the one-time Privy authorization as soon as the wallet is ready so a
 * later transaction only needs prepare, a local signature, and submission.
 * Concurrent transaction requests reuse the same in-flight setup promise.
 */
export async function prepareKernelSessionKey(input: {
  chainId: number;
  owner: Address;
  provider: EthereumProvider;
  publicClient?: SessionPublicClient;
}): Promise<{ created: boolean; setupMs: number; validUntil: number }> {
  const startedAt = performance.now();
  const { created, session } = await getOrCreateSession(input);
  const setupMs = created ? Math.round(performance.now() - startedAt) : 0;
  console.info("Kernel session login setup latency", { created, setupMs });
  return { created, setupMs, validUntil: session.validUntil };
}

/**
 * One Privy root signature creates an in-memory, 24-hour Kernel permission.
 * Session creation belongs to the login/background lifecycle. Transaction
 * submission only reads the prepared session and signs locally with its key.
 */
export async function submitDirectUserOperationWithSessionKey<T = never>(input: {
  accessToken: string;
  chainId: number;
  calls: readonly AtomicCall[];
  sender: Address;
  onAccountNotDelegated?: () => Promise<T>;
  fetchFn?: typeof fetch;
}): Promise<DirectUserOperationResult | T> {
  const totalStartedAt = performance.now();
  const session = await getPreparedSession(input.chainId, input.sender);
  const mode = session.enabled ? KERNEL_PERMISSION_MODE_DEFAULT : KERNEL_PERMISSION_MODE_ENABLE;
  const nonceKey = encodeKernelV33PermissionNonceKey(session.permissionId, 0n, mode);
  const nonceSequence = mode === KERNEL_PERMISSION_MODE_DEFAULT ? session.nonceSequence : 0n;

  const prepareStartedAt = performance.now();
  const prepared = prepareLocalSessionUserOperation({
    chainId: input.chainId,
    sender: input.sender,
    calls: input.calls,
    nonceKey,
    nonceSequence,
  });
  const prepareMs = Math.round(performance.now() - prepareStartedAt);

  const signStartedAt = performance.now();
  const sessionAccount = privateKeyToAccount(session.privateKey);
  const rawSignature = await sessionAccount.signMessage({ message: { raw: prepared.userOpHash } });
  const userOpSignature = encodeKernelV33PermissionUserOpSignature(rawSignature);
  const signature = session.enabled
    ? userOpSignature
    : encodeKernelV33PermissionEnableSignature({
        validatorData: session.validatorData,
        enableSignature: session.enableSignature,
        userOpSignature,
      });
  const signMs = Math.round(performance.now() - signStartedAt);

  const submitStartedAt = performance.now();
  let submitted: DirectUserOperationSubmitResponse;
  try {
    submitted = await submitDirectUserOperation({
      accessToken: input.accessToken,
      chainId: input.chainId,
      calls: input.calls,
      operation: prepared.operation,
      signature,
      signatureMode: "kernel-permission",
      fetchFn: input.fetchFn,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ACCOUNT_NOT_DELEGATED" &&
      input.onAccountNotDelegated
    ) {
      return input.onAccountNotDelegated();
    }
    throw error;
  }
  const hash = submitted.hash;
  const submitMs = Math.round(performance.now() - submitStartedAt);
  if (mode === KERNEL_PERMISSION_MODE_DEFAULT) session.nonceSequence += 1n;
  session.enabled = true;
  const metrics = {
    setupMs: 0,
    prepareMs,
    prepareBreakdown: prepared.timing,
    signMs,
    submitMs,
    submitBreakdown: submitted.timing,
    totalMs: Math.round(performance.now() - totalStartedAt),
  };
  console.info("Kernel session UserOperation latency", { ...metrics, hash });
  return { hash, metrics };
}
