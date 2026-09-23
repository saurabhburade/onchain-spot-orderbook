// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import { type Address, defineChain, type Hex, http, parseAbi } from "viem";
import { monadTestnet } from "viem/chains";

import { MONAD_TESTNET_CHAIN_ID } from "../../../config/constants.ts";
import { clobContractsByChainId } from "../../../config/contracts.ts";

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

export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_NONCE_KEY = 1n << 176n;
export const MAX_ENTRY_POINT_NONCE_KEY = 1n << 192n;
export const EIP7702_CODE = `${EIP7702_DELEGATION_PREFIX}${KERNEL_V33_DELEGATE.slice(2)}`.toLowerCase();
export const monadContracts = clobContractsByChainId[MONAD_TESTNET_CHAIN_ID];

export type PublicClient = any;
export type WalletClient = any;

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

export type CallValidationTiming = {
  orderBookMs: number;
  policyRpcMs: number;
};

export const entryPointAbi = parseAbi([
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address payable beneficiary)",
]);

export const kernelAbi = parseAbi(["function execute(bytes32 execMode,bytes executionCalldata) payable"]);
export const approveAbi = [
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
export const claimAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
] as const;
export const transferAbi = [
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

export function directRpcUrl() {
  return process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
}

export function directChain() {
  return defineChain({
    ...monadTestnet,
    rpcUrls: { default: { http: [directRpcUrl()] } },
  });
}

export function directTransport() {
  return http(directRpcUrl(), {
    batch: { batchSize: 10, wait: 0 },
    retryCount: 0,
  });
}

export function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export async function measure<T>(task: () => Promise<T>, record: (durationMs: number) => void): Promise<T> {
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
