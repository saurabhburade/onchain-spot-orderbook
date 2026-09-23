// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import { encodeAbiParameters, type Hex, keccak256 } from "viem";

import { DIRECT_USEROP_CHAIN_ID, ENTRY_POINT_V07, entryPointAbi, type PackedUserOperation } from "./constants.ts";
import { hexNumber } from "./validation.ts";

export function contractPackedOperation(operation: PackedUserOperation) {
  return {
    ...operation,
    nonce: hexNumber(operation.nonce, "nonce"),
    preVerificationGas: hexNumber(operation.preVerificationGas, "preVerificationGas"),
  };
}

export function userOpHash(publicClient: any, operation: PackedUserOperation) {
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
