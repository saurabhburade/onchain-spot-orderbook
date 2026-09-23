// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  hashMessage,
  isHash,
  isHex,
  recoverAddress,
} from "viem";
import { createDirectUserOperationClients, sponsorAddress, sponsorChainId } from "./clients.ts";
import {
  DIRECT_USEROP_CHAIN_ID,
  DirectUserOperationError,
  ENTRY_POINT_V07,
  elapsedMs,
  entryPointAbi,
  MAX_KERNEL_PERMISSION_SIGNATURE_BYTES,
  MAX_OUTER_GAS_LIMIT,
  measure,
  type PackedUserOperation,
  type PublicClient,
} from "./constants.ts";
import { contractPackedOperation, userOpHash } from "./hashing.ts";
import {
  assertDelegatedAccount,
  assertSafeUserOperationGas,
  assertSignatureModeNonceKey,
  encodeAllowedCalls,
  hexNumber,
  parsePackedUserOperation,
} from "./validation.ts";

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
  publicClient: PublicClient,
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
  publicClient: PublicClient,
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
  const chainId = sponsorChainId(walletClient);
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
          // Direct relay intentionally broadcasts the exact signed payload.
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
  const publicClient: PublicClient = clients.publicClient;
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
  const callTiming = { orderBookMs: 0, policyRpcMs: 0 };
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
