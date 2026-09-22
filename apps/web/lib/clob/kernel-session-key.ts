import {
  type Address,
  concatHex,
  encodeAbiParameters,
  getAbiItem,
  type Hex,
  isAddress,
  isHex,
  keccak256,
  maxUint256,
  pad,
  parseAbi,
  size,
  slice,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from "viem";

import { clobAbi } from "../../config/abis/clob.ts";
import { erc20Abi } from "../../config/abis/erc20.ts";
import { poolRegistryAbi } from "../../config/abis/pool-registry.ts";
import { tokenFactoryAbi, tokenFaucetAbi } from "../../config/abis/token.ts";

/**
 * Compatibility constants for the repository's existing direct v0.7 flow.
 * These are the values exported by @zerodev/sdk 5.5.10 for Kernel v3.3.
 */
export const KERNEL_V33_VERSION = "0.3.3" as const;
export const KERNEL_V33_DELEGATE = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28" as Address;
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
export const MONAD_TESTNET_CHAIN_ID = 10_143;

// Kernel v3's permission validator uses the legacy one-byte mode/type prefix.
// Do not substitute Kernel v4's 0x08/0x0c enable-mode encoding here.
export const KERNEL_PERMISSION_MODE_DEFAULT = "0x00" as Hex;
export const KERNEL_PERMISSION_MODE_ENABLE = "0x01" as Hex;
export const KERNEL_PERMISSION_VALIDATOR_TYPE = "0x02" as Hex;
export const KERNEL_PERMISSION_SIGNATURE_PREFIX = "0xff" as Hex;
export const ECDSA_SIGNER_CONTRACT = "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF" as Address;
export const CALL_POLICY_CONTRACT_V0_0_4 = "0x9a52283276A0ec8740DF50bF01B28A80D880eaf2" as Address;
export const TIMESTAMP_POLICY_CONTRACT = "0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F" as Address;
export const RATE_LIMIT_POLICY_CONTRACT = "0xf63d4139B25c836334edD76641356c6b74C86873" as Address;
export const SESSION_VALIDITY_SECONDS = 24 * 60 * 60;
export const SESSION_MAX_OPERATIONS = 1_000;
const POLICY_FLAGS_ALL_VALIDATION = "0x0000" as Hex;

const kernelExecuteAbi = parseAbi(["function execute(bytes32 execMode,bytes executionCalldata) payable"]);
const enableTypedDataTypes = {
  Enable: [
    { name: "validationId", type: "bytes21" },
    { name: "nonce", type: "uint32" },
    { name: "hook", type: "address" },
    { name: "validatorData", type: "bytes" },
    { name: "hookData", type: "bytes" },
    { name: "selectorData", type: "bytes" },
  ],
} as const;

const enableEnvelopeTypes = [
  { name: "validatorData", type: "bytes" },
  { name: "hookData", type: "bytes" },
  { name: "selectorData", type: "bytes" },
  { name: "enableSignature", type: "bytes" },
  { name: "userOpSignature", type: "bytes" },
] as const;

const selectorInitTypes = [
  { name: "selectorInitData", type: "bytes" },
  { name: "hookInitData", type: "bytes" },
] as const;

export const KERNEL_V33_EXECUTE_SELECTOR = toFunctionSelector(getAbiItem({ abi: kernelExecuteAbi, name: "execute" }));

export const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as Hex;

export type KernelPermissionCallType = "0x00" | "0x01" | "0xff";

export type KernelPermissionRule = {
  condition: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  offset: number;
  params: Hex | readonly Hex[];
};

export type KernelCallPermission = {
  callType: KernelPermissionCallType;
  target: Address;
  selector: Hex;
  valueLimit: bigint;
  rules: readonly KernelPermissionRule[];
};

export type ClobSessionMarket = {
  book: Address;
  baseAsset: Address;
  quoteAsset: Address;
};

export type KernelPermissionConfiguration = {
  permissionId: Hex;
  validatorData: Hex;
  validAfter: number;
  validUntil: number;
};

function assertAddress(value: Address, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} must be a valid address`);
  return value;
}
function assertPermissionId(permissionId: Hex): Hex {
  if (!isHex(permissionId, { strict: true }) || size(permissionId) !== 4) {
    throw new Error("permissionId must be exactly 4 bytes");
  }
  return permissionId;
}

function assertSignature(signature: Hex, label: string): Hex {
  // @zerodev/permissions' toECDSASigner normalizes signatures with fixSignedData
  // before toPermissionValidator adds the 0xff prefix.
  if (!isHex(signature, { strict: true }) || size(signature) !== 65) {
    throw new Error(`${label} must be a canonical 65-byte ECDSA signature`);
  }
  return signature;
}

/**
 * Kernel v3.3's permission nonce key. The returned bigint is the 192-bit key
 * passed to EntryPoint.getNonce(address, key), before the 64-bit sequence.
 */
export function encodeKernelV33PermissionNonceKey(
  permissionId: Hex,
  customNonceKey = 0n,
  mode: Hex = KERNEL_PERMISSION_MODE_DEFAULT,
): bigint {
  const id = assertPermissionId(permissionId);
  if (customNonceKey < 0n || customNonceKey > 0xffffn) {
    throw new Error("customNonceKey must fit into uint16");
  }
  if (mode !== KERNEL_PERMISSION_MODE_DEFAULT && mode !== KERNEL_PERMISSION_MODE_ENABLE) {
    throw new Error("Kernel v3.3 permission mode must be 0x00 or 0x01");
  }
  return BigInt(
    concatHex([
      mode,
      KERNEL_PERMISSION_VALIDATOR_TYPE,
      pad(id, { size: 20, dir: "right" }),
      toHex(customNonceKey, { size: 2 }),
    ]),
  );
}

/** The bytes21 validation id signed in Kernel's Enable EIP-712 message. */
export function encodeKernelV33PermissionValidationId(permissionId: Hex): Hex {
  return concatHex([
    KERNEL_PERMISSION_VALIDATOR_TYPE,
    pad(assertPermissionId(permissionId), { size: 20, dir: "right" }),
  ]);
}

/**
 * The exact EIP-712 payload signed once by the root validator to install the
 * regular permission validator for the default execute action.
 */
export function getKernelV33PermissionEnableTypedData(input: {
  account: Address;
  chainId: number;
  permissionId: Hex;
  validatorData: Hex;
  nonce: number;
  hookData?: Hex;
}): {
  domain: { name: "Kernel"; version: typeof KERNEL_V33_VERSION; chainId: number; verifyingContract: Address };
  types: typeof enableTypedDataTypes;
  primaryType: "Enable";
  message: {
    validationId: Hex;
    nonce: number;
    hook: Address;
    validatorData: Hex;
    hookData: Hex;
    selectorData: Hex;
  };
} {
  const account = assertAddress(input.account, "account");
  const hookData = input.hookData ?? "0x";
  if (!Number.isInteger(input.chainId) || input.chainId < 0) throw new Error("chainId must be a non-negative integer");
  if (!Number.isInteger(input.nonce) || input.nonce < 0 || input.nonce > 0xffff_ffff) {
    throw new Error("enable nonce must fit into uint32");
  }
  if (!isHex(input.validatorData) || !isHex(hookData)) throw new Error("validatorData and hookData must be hex");

  // This mirrors @zerodev/sdk's getPluginsEnableTypedDataV2 for EP v0.7:
  // action.selector || action.address || action.hook || abi.encode(bytes,bytes).
  const selectorData = concatHex([
    KERNEL_V33_EXECUTE_SELECTOR,
    zeroAddress,
    zeroAddress,
    encodeAbiParameters(selectorInitTypes, ["0xff", "0x0000"]),
  ]);

  return {
    domain: {
      name: "Kernel",
      version: KERNEL_V33_VERSION,
      chainId: input.chainId,
      verifyingContract: account,
    },
    types: enableTypedDataTypes,
    primaryType: "Enable",
    message: {
      validationId: encodeKernelV33PermissionValidationId(input.permissionId),
      nonce: input.nonce,
      hook: zeroAddress,
      validatorData: input.validatorData,
      hookData,
      selectorData,
    },
  };
}

/** Signature used by toPermissionValidator after the permission is enabled. */
export function encodeKernelV33PermissionUserOpSignature(rawSignature: Hex): Hex {
  return concatHex([KERNEL_PERMISSION_SIGNATURE_PREFIX, assertSignature(rawSignature, "UserOperation signature")]);
}

/**
 * Signature used by the first enabling UserOperation. The outer 20-byte hook
 * id is zero, followed by the ABI encoding emitted by getEncodedPluginsDataV2.
 */
export function encodeKernelV33PermissionEnableSignature(input: {
  validatorData: Hex;
  hookData?: Hex;
  enableSignature: Hex;
  userOpSignature: Hex;
  selectorData?: Hex;
}): Hex {
  const hookData = input.hookData ?? "0x";
  const selectorData =
    input.selectorData ??
    concatHex([
      KERNEL_V33_EXECUTE_SELECTOR,
      zeroAddress,
      zeroAddress,
      encodeAbiParameters(selectorInitTypes, ["0xff", "0x0000"]),
    ]);
  if (!isHex(input.validatorData) || !isHex(hookData) || !isHex(selectorData)) {
    throw new Error("Kernel enable data must be hex");
  }
  return concatHex([
    zeroAddress,
    encodeAbiParameters(enableEnvelopeTypes, [
      input.validatorData,
      hookData,
      selectorData,
      assertSignature(input.enableSignature, "enable signature"),
      input.userOpSignature,
    ]),
  ]);
}

function selector(name: string): Hex {
  return toFunctionSelector(getAbiItem({ abi: clobAbi, name: name as never }) as never);
}

/**
 * A deliberately narrow CLOB policy matrix. It permits order/cancel calls on
 * configured books and approve(spender, amount) on the two assets of each
 * configured market. It does not grant transfers, faucet claims, market
 * creation, token creation, native transfers, or delegatecall.
 */
export function createClobSessionCallPermissions(markets: readonly ClobSessionMarket[]): KernelCallPermission[] {
  const permissions: KernelCallPermission[] = [];
  for (const market of markets) {
    const book = assertAddress(market.book, "market.book");
    for (const name of ["placeLimitOrderWithMaxBookSteps", "executeMarketOrder", "cancelOrder"]) {
      permissions.push({
        callType: "0x00",
        target: book,
        selector: selector(name),
        valueLimit: 0n,
        rules: [],
      });
    }
    for (const asset of [market.baseAsset, market.quoteAsset]) {
      permissions.push({
        callType: "0x00",
        target: assertAddress(asset, "market asset"),
        selector: ERC20_APPROVE_SELECTOR,
        valueLimit: 0n,
        // approve's first ABI word is the spender. The rule is relative to
        // calldata arguments, matching @zerodev/permissions CallPolicy.
        rules: [{ condition: 0, offset: 0, params: pad(book, { size: 32 }) }],
      });
    }
  }
  return permissions;
}

function selectorsForAbi(abi: readonly unknown[], name: string): Hex[] {
  return abi
    .filter((item) => typeof item === "object" && item !== null && "type" in item && "name" in item)
    .filter(
      (item) =>
        (item as { type?: string; name?: string }).type === "function" && (item as { name?: string }).name === name,
    )
    .map((item) => toFunctionSelector(item as never));
}

/**
 * On-chain guard shared by every app transaction. Targets remain dynamic for
 * user-created markets and imported ERC-20s, while selectors are restricted to
 * the exact write methods the UI exposes. The server remains the stricter
 * authority: it validates concrete targets, arguments, values, and ownership.
 */
export function createAppSessionCallPermissions(): KernelCallPermission[] {
  const selectors = [
    ...selectorsForAbi(clobAbi, "placeLimitOrderWithMaxBookSteps"),
    ...selectorsForAbi(clobAbi, "executeMarketOrder"),
    ...selectorsForAbi(clobAbi, "cancelOrder"),
    ...selectorsForAbi(erc20Abi, "approve"),
    ...selectorsForAbi(erc20Abi, "transfer"),
    ...selectorsForAbi(tokenFaucetAbi, "claim"),
    ...selectorsForAbi(tokenFactoryAbi, "createToken"),
    ...selectorsForAbi(poolRegistryAbi, "createPair"),
  ];
  const unique = [...new Set(selectors.map((value) => value.toLowerCase()))] as Hex[];
  return [
    ...unique.map((selector) => ({
      callType: "0x00" as const,
      target: zeroAddress,
      selector,
      valueLimit: selector === "0x00000000" ? maxUint256 : 0n,
      rules: [],
    })),
    // CallPolicy v0.0.4 treats zero target + zero selector as bounded native transfer.
    { callType: "0x00", target: zeroAddress, selector: "0x00000000", valueLimit: maxUint256, rules: [] },
  ];
}

function encodeCallPolicyData(permissions: readonly KernelCallPermission[]): Hex {
  return encodeAbiParameters(
    [
      {
        name: "permission",
        type: "tuple[]",
        components: [
          { name: "callType", type: "bytes1" },
          { name: "target", type: "address" },
          { name: "selector", type: "bytes4" },
          { name: "valueLimit", type: "uint256" },
          {
            name: "rules",
            type: "tuple[]",
            components: [
              { name: "condition", type: "uint8" },
              { name: "offset", type: "uint64" },
              { name: "params", type: "bytes32[]" },
            ],
          },
        ],
      },
    ],
    [
      permissions.map((permission) => ({
        ...permission,
        rules: permission.rules.map((rule) => ({
          ...rule,
          offset: BigInt(rule.offset),
          params: typeof rule.params === "string" ? [rule.params] : [...rule.params],
        })),
      })),
    ],
  );
}

function policyData(address: Address, data: Hex): Hex {
  return concatHex([POLICY_FLAGS_ALL_VALIDATION, address, data]);
}

/** Build the exact @zerodev/permissions v5 permission data without a runtime SDK dependency. */
export function createAppKernelPermissionConfiguration(input: {
  sessionKey: Address;
  validAfter?: number;
  validUntil?: number;
}): KernelPermissionConfiguration {
  const sessionKey = assertAddress(input.sessionKey, "sessionKey");
  const validAfter = input.validAfter ?? Math.floor(Date.now() / 1_000) - 30;
  const validUntil = input.validUntil ?? validAfter + SESSION_VALIDITY_SECONDS;
  if (!Number.isInteger(validAfter) || !Number.isInteger(validUntil) || validAfter < 0 || validUntil <= validAfter) {
    throw new Error("session permission validity is invalid");
  }
  const policies = [
    policyData(CALL_POLICY_CONTRACT_V0_0_4, encodeCallPolicyData(createAppSessionCallPermissions())),
    policyData(
      TIMESTAMP_POLICY_CONTRACT,
      encodeAbiParameters(
        [
          { name: "validAfter", type: "uint48" },
          { name: "validUntil", type: "uint48" },
        ],
        [validAfter, validUntil],
      ),
    ),
    policyData(
      RATE_LIMIT_POLICY_CONTRACT,
      concatHex([
        // The non-reset RateLimit policy interprets interval as the minimum
        // delay between operations, not as a rolling window. Zero keeps the
        // 1,000-operation cap without throttling every transaction for 24h.
        toHex(0, { size: 6 }),
        toHex(SESSION_MAX_OPERATIONS, { size: 6 }),
        toHex(validAfter, { size: 6 }),
      ]),
    ),
  ];
  const signerData = concatHex([POLICY_FLAGS_ALL_VALIDATION, ECDSA_SIGNER_CONTRACT, sessionKey]);
  const validatorData = encodeAbiParameters(
    [{ name: "policyAndSignerData", type: "bytes[]" }],
    [[...policies, signerData]],
  );
  const policyIdData = encodeAbiParameters([{ name: "policiesData", type: "bytes[]" }], [policies]);
  const signerIdData = encodeAbiParameters(
    [{ name: "signerData", type: "bytes" }],
    [concatHex([ECDSA_SIGNER_CONTRACT, sessionKey])],
  );
  const permissionId = slice(
    keccak256(
      encodeAbiParameters(
        [{ name: "policyAndSignerData", type: "bytes[]" }],
        [[policyIdData, POLICY_FLAGS_ALL_VALIDATION, signerIdData]],
      ),
    ),
    0,
    4,
  );
  return { permissionId, validatorData, validAfter, validUntil };
}

export type BrowserSessionKeyRecord = {
  version: 1;
  account: Address;
  chainId: number;
  kernelVersion: typeof KERNEL_V33_VERSION;
  entryPoint: Address;
  sessionKey: Address;
  permissionId: Hex;
  serializedPermissionAccount: string;
  validUntil: number;
};

/**
 * Storage intentionally contains the ZeroDev approval blob but not the
 * session private key. Keep the private key in an app-controlled encrypted
 * IndexedDB/WebCrypto store and pass its signer to deserializePermissionAccount.
 */
export function serializeBrowserSessionKeyRecord(record: BrowserSessionKeyRecord): string {
  validateBrowserSessionKeyRecord(record);
  return JSON.stringify(record);
}

export function parseBrowserSessionKeyRecord(serialized: string): BrowserSessionKeyRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("session-key storage record is not valid JSON");
  }
  validateBrowserSessionKeyRecord(value);
  return value;
}

export function assertBrowserSessionKeyUsable(
  record: BrowserSessionKeyRecord,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  validateBrowserSessionKeyRecord(record);
  if (record.validUntil !== 0 && nowSeconds >= record.validUntil) {
    throw new Error("session key permission has expired");
  }
}

function validateBrowserSessionKeyRecord(value: unknown): asserts value is BrowserSessionKeyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid session-key storage record");
  const record = value as Partial<BrowserSessionKeyRecord>;
  if (record.version !== 1) throw new Error("unsupported session-key storage version");
  if (!record.account || !isAddress(record.account)) throw new Error("session record account is invalid");
  if (typeof record.chainId !== "number" || !Number.isInteger(record.chainId) || record.chainId < 0) {
    throw new Error("session record chainId is invalid");
  }
  if (record.kernelVersion !== KERNEL_V33_VERSION) throw new Error("session record Kernel version is invalid");
  if (!record.entryPoint || !isAddress(record.entryPoint)) throw new Error("session record EntryPoint is invalid");
  if (!record.sessionKey || !isAddress(record.sessionKey)) throw new Error("session record session key is invalid");
  assertPermissionId(record.permissionId as Hex);
  if (typeof record.serializedPermissionAccount !== "string" || record.serializedPermissionAccount.length === 0) {
    throw new Error("session record approval blob is missing");
  }
  if (!Number.isInteger(record.validUntil) || (record.validUntil as number) < 0) {
    throw new Error("session record validUntil is invalid");
  }
}
