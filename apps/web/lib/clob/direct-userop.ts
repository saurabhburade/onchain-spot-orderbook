// Stable public facade for direct UserOperation preparation and submission.
// Direct relay transport keeps the exact fixed settings: batch: { batchSize: 10, wait: 0 } and retryCount: 0.
// Sponsor submission uses method: "eth_sendRawTransaction" for the signed payload.

export { createDirectUserOperationClients, createDirectUserOperationPublicClient } from "./user-operations/clients.ts";
export type {
  DirectUserOperationClients,
  DirectUserOperationPrepareTiming,
  PackedUserOperation,
} from "./user-operations/constants.ts";
export {
  ACCOUNT_NOT_DELEGATED,
  DIRECT_USEROP_CHAIN_ID,
  DirectUserOperationError,
  EIP7702_DELEGATION_PREFIX,
  ENTRY_POINT_V07,
  KERNEL_V33_DELEGATE,
  MAX_CALLDATA_BYTES,
  MAX_KERNEL_PERMISSION_SIGNATURE_BYTES,
  MAX_OUTER_GAS_LIMIT,
  USEROP_CALL_GAS_LIMIT,
  USEROP_MAX_FEE_PER_GAS,
  USEROP_MAX_PRIORITY_FEE_PER_GAS,
  USEROP_PRE_VERIFICATION_GAS,
  USEROP_VERIFICATION_GAS_LIMIT,
} from "./user-operations/constants.ts";
export { localUserOpHash } from "./user-operations/hashing.ts";
export { prepareDirectUserOperation } from "./user-operations/prepare.ts";
export { submitDirectUserOperation } from "./user-operations/submit.ts";
export {
  assertDelegatedAccount,
  encodeAllowedCalls,
  encodeKernelSingleCall,
  packUint128Pair,
  packUserOperation,
  parsePackedUserOperation,
} from "./user-operations/validation.ts";
