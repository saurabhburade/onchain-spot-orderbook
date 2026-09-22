import assert from "node:assert/strict";
import test from "node:test";

import { decodeAbiParameters, size, slice } from "viem";

import {
  assertBrowserSessionKeyUsable,
  createAppKernelPermissionConfiguration,
  createAppSessionCallPermissions,
  createClobSessionCallPermissions,
  encodeKernelV33PermissionEnableSignature,
  encodeKernelV33PermissionNonceKey,
  encodeKernelV33PermissionUserOpSignature,
  encodeKernelV33PermissionValidationId,
  getKernelV33PermissionEnableTypedData,
  KERNEL_PERMISSION_MODE_DEFAULT,
  KERNEL_V33_EXECUTE_SELECTOR,
  KERNEL_V33_VERSION,
  parseBrowserSessionKeyRecord,
  serializeBrowserSessionKeyRecord,
} from "./kernel-session-key.ts";

const account = "0x0000000000000000000000000000000000000001" as const;
const permissionId = "0x11223344" as const;
const rawSignature = `0x${"11".repeat(64)}1b` as const;

test("encodes Kernel v3.3 permission validation id and nonce key", () => {
  assert.equal(encodeKernelV33PermissionValidationId(permissionId), `0x0211223344${"00".repeat(16)}`);
  const nonceKey = encodeKernelV33PermissionNonceKey(permissionId, 7n);
  assert.equal(nonceKey, BigInt(`0x00${"02"}11223344${"00".repeat(16)}${"00"}07`));
  assert.equal(encodeKernelV33PermissionNonceKey(permissionId, 7n, KERNEL_PERMISSION_MODE_DEFAULT), nonceKey);
});

test("matches the v3.3 Enable typed-data shape", () => {
  const typedData = getKernelV33PermissionEnableTypedData({
    account,
    chainId: 10143,
    permissionId,
    validatorData: "0x1234",
    nonce: 1,
  });
  assert.equal(typedData.domain.name, "Kernel");
  assert.equal(typedData.domain.version, KERNEL_V33_VERSION);
  assert.equal(typedData.primaryType, "Enable");
  assert.equal(typedData.message.validationId, `0x0211223344${"00".repeat(16)}`);
  assert.equal(typedData.message.hook, "0x0000000000000000000000000000000000000000");
  assert.equal(typedData.message.selectorData.slice(0, 10), KERNEL_V33_EXECUTE_SELECTOR);
});

test("uses 0xff plus the canonical ECDSA signature after enable", () => {
  const standard = encodeKernelV33PermissionUserOpSignature(rawSignature);
  assert.equal(standard, `0xff${rawSignature.slice(2)}`);

  const enabled = encodeKernelV33PermissionEnableSignature({
    validatorData: "0x1234",
    enableSignature: rawSignature,
    userOpSignature: standard,
  });
  assert.equal(enabled.slice(0, 42), "0x0000000000000000000000000000000000000000");
  assert.ok(size(enabled) > size(standard));
});

test("creates only CLOB order and exact-book approval permissions", () => {
  const permissions = createClobSessionCallPermissions([
    {
      book: "0x0000000000000000000000000000000000000010",
      baseAsset: "0x0000000000000000000000000000000000000011",
      quoteAsset: "0x0000000000000000000000000000000000000012",
    },
  ]);
  assert.equal(permissions.length, 5);
  assert.equal(permissions.filter((permission) => permission.rules.length > 0).length, 2);
  assert.ok(permissions.every((permission) => permission.callType === "0x00"));
  assert.ok(permissions.every((permission) => permission.valueLimit === 0n));
});

test("builds a bounded all-app permission with deterministic validator data", () => {
  const sessionKey = "0x0000000000000000000000000000000000000020" as const;
  const first = createAppKernelPermissionConfiguration({
    sessionKey,
    validAfter: 1_000,
    validUntil: 2_000,
  });
  const second = createAppKernelPermissionConfiguration({
    sessionKey,
    validAfter: 1_000,
    validUntil: 2_000,
  });
  assert.equal(first.permissionId, second.permissionId);
  assert.equal(first.validatorData, second.validatorData);
  assert.equal(size(first.permissionId), 4);
  assert.ok(size(first.validatorData) > 100);

  const [policyAndSignerData] = decodeAbiParameters(
    [{ name: "policyAndSignerData", type: "bytes[]" }],
    first.validatorData,
  );
  const rateLimitPolicy = policyAndSignerData.find((entry) =>
    entry.toLowerCase().includes("f63d4139b25c836334edd76641356c6b74c86873"),
  );
  assert.ok(rateLimitPolicy);
  assert.equal(slice(rateLimitPolicy, 22, 28), `0x${"00".repeat(6)}`);

  const permissions = createAppSessionCallPermissions();
  assert.ok(permissions.some((permission) => permission.selector === "0x095ea7b3"));
  assert.ok(permissions.some((permission) => permission.selector === "0xa9059cbb"));
  assert.ok(permissions.some((permission) => permission.selector === "0x00000000"));
  assert.ok(permissions.every((permission) => permission.target === "0x0000000000000000000000000000000000000000"));
});

test("round-trips browser metadata without storing a private key", () => {
  const record = {
    version: 1 as const,
    account,
    chainId: 10143,
    kernelVersion: KERNEL_V33_VERSION,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const,
    sessionKey: "0x0000000000000000000000000000000000000002" as const,
    permissionId,
    serializedPermissionAccount: "approval-base64",
    validUntil: 2_000,
  };
  const serialized = serializeBrowserSessionKeyRecord(record);
  assert.deepEqual(parseBrowserSessionKeyRecord(serialized), record);
  assertBrowserSessionKeyUsable(record, 1_999);
  assert.throws(() => assertBrowserSessionKeyUsable(record, 2_000), /expired/);
  assert.equal(serialized.includes("privateKey"), false);
});
