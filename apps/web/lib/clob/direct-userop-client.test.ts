import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { hashMessage } = require("viem") as typeof import("viem");
const {
  isAccountNotDelegatedError,
  prepareDirectUserOperation,
  prepareLocalSessionUserOperation,
  submitDirectUserOperationWithWallet,
  warmDirectUserOperationAuth,
} = require("./direct-userop-client.ts") as typeof import("./direct-userop-client");
const { localUserOpHash } = require("./direct-userop.ts") as typeof import("./direct-userop");

const sender = "0x1111111111111111111111111111111111111111" as const;
const userOpHash = `0x${"12".repeat(32)}` as const;
const kernelSigningHash = hashMessage({ raw: userOpHash });
const operation = {
  sender,
  nonce: "0x01",
  initCode: "0x",
  callData: "0x1234",
  accountGasLimits: `0x${"11".repeat(32)}`,
  preVerificationGas: "0x02",
  gasFees: `0x${"22".repeat(32)}`,
  paymasterAndData: "0x",
  signature: "0x",
} as const;
const prepareServerTiming = {
  authMs: 17,
  serverMs: 103,
  rpcWallMs: 79,
  chainIdMs: 71,
  delegationMs: 73,
  orderBookMs: 76,
  policyRpcMs: 0,
  nonceMs: 78,
  localMs: 2,
};
const submitServerTiming = {
  authMs: 3,
  serverMs: 211,
  validationWallMs: 121,
  chainIdMs: 101,
  delegationMs: 102,
  orderBookMs: 103,
  policyRpcMs: 0,
  nonceMs: 104,
  hashMs: 105,
  simulationMs: 120,
  broadcastMs: 80,
  broadcastPrepareMs: 20,
  sponsorNonceMs: 19,
  gasPriceMs: 18,
  sponsorSignMs: 1,
  rpcSubmissionMs: 59,
};

test("locally prepares the exact EntryPoint signing hash without an API request", () => {
  const nonceKey = BigInt(`0x0002${"11".repeat(16)}223344550000`);
  const prepared = prepareLocalSessionUserOperation({
    chainId: 10_143,
    sender,
    calls: [{ to: sender, data: "0xabcdef" }],
    nonceKey,
    nonceSequence: 7n,
  });

  assert.equal(BigInt(prepared.operation.nonce), (nonceKey << 64n) | 7n);
  assert.equal(prepared.operation.signature, "0x");
  assert.equal(prepared.userOpHash, localUserOpHash(prepared.operation));
});

test("warms sponsor authentication without preparing or submitting a UserOperation", async () => {
  let observed: { url: string; method?: string; authorization: string | null } | undefined;
  const timing = await warmDirectUserOperationAuth({
    chainId: 10_143,
    accessToken: "privy-token",
    fetchFn: async (input, init) => {
      observed = {
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
      };
      return Response.json({ ok: true, authMs: 7 });
    },
  });

  assert.deepEqual(observed, {
    url: "/api/userops/auth",
    method: "POST",
    authorization: "Bearer privy-token",
  });
  assert.equal(timing.serverAuthMs, 7);
  assert.ok(timing.totalMs >= 0);
});

test("prepares, signs, and submits the exact returned UserOperation", async () => {
  const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(
      requests.length === 1
        ? JSON.stringify({ operation, userOpHash, timing: prepareServerTiming })
        : JSON.stringify({ hash: `0x${"34".repeat(32)}`, timing: submitServerTiming }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const calls = [{ to: sender, data: "0xabcdef" as const, value: 2n }];
  let signedHash: unknown;
  const signature = `0x${"ab".repeat(65)}`;
  const result = await submitDirectUserOperationWithWallet({
    accessToken: "privy-token",
    chainId: 10_143,
    calls,
    provider: {
      request: async (args) => {
        const { method, params } = args as { method: string; params?: readonly unknown[] };
        signedHash = { method, params };
        return signature;
      },
    },
    sender,
    fetchFn,
  });

  assert.deepEqual(signedHash, { method: "secp256k1_sign", params: [kernelSigningHash] });
  assert.deepEqual(requests[0], {
    url: "/api/userops/prepare",
    body: { sender, calls: [{ to: sender, data: "0xabcdef", value: "0x2" }] },
    headers: { authorization: "Bearer privy-token", "content-type": "application/json" },
  });
  assert.deepEqual(requests[1], {
    url: "/api/userops/submit",
    body: {
      calls: [{ to: sender, data: "0xabcdef", value: "0x2" }],
      operation,
      signature,
      signatureMode: "root",
    },
    headers: { authorization: "Bearer privy-token", "content-type": "application/json" },
  });
  assert.equal(result.hash, `0x${"34".repeat(32)}`);
  assert.ok(result.metrics.signMs >= 0);
  assert.ok(result.metrics.submitMs >= 0);
  assert.ok(result.metrics.totalMs >= result.metrics.signMs);
  assert.deepEqual(result.metrics.prepareBreakdown, {
    ...prepareServerTiming,
    networkMs: result.metrics.prepareBreakdown?.networkMs,
    responseMs: result.metrics.prepareBreakdown?.responseMs,
  });
  assert.ok((result.metrics.prepareBreakdown?.networkMs ?? -1) >= 0);
  assert.ok((result.metrics.prepareBreakdown?.responseMs ?? -1) >= 0);
  assert.deepEqual(result.metrics.submitBreakdown, {
    ...submitServerTiming,
    networkMs: result.metrics.submitBreakdown?.networkMs,
    responseMs: result.metrics.submitBreakdown?.responseMs,
  });
  assert.ok((result.metrics.submitBreakdown?.networkMs ?? -1) >= 0);
  assert.ok((result.metrics.submitBreakdown?.responseMs ?? -1) >= 0);
});

test("recognizes only the delegated-account prepare response for fallback", async () => {
  const response = new Response(JSON.stringify({ error: "Account is not delegated", code: "ACCOUNT_NOT_DELEGATED" }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(
    prepareDirectUserOperation({
      chainId: 10_143,
      sender,
      calls: [{ to: sender }],
      accessToken: "privy-token",
      fetchFn: async () => response,
    }),
    (error: unknown) => {
      assert.equal(isAccountNotDelegatedError(error), true);
      return true;
    },
  );
  assert.equal(isAccountNotDelegatedError(new Error("ACCOUNT_NOT_DELEGATED")), false);
});

test("uses Privy's raw signer while preserving the embedded-wallet provider receiver", async () => {
  const requests: unknown[] = [];
  const signature = `0x${"ab".repeat(65)}` as const;
  const { signDirectUserOperation } = require("./direct-userop-client.ts") as typeof import("./direct-userop-client");
  const provider = {
    address: sender,
    async request(this: { address: string }, request: unknown) {
      // Privy's provider request method reads account state from `this`. Calling
      // it as a detached function reproduces the browser's exact `.address` crash.
      assert.equal(this.address, sender);
      requests.push(request);
      const { method } = request as { method: string };
      if (method !== "secp256k1_sign") throw new Error(`Method not supported: ${method}`);
      return signature;
    },
  };

  const result = await signDirectUserOperation(provider, userOpHash, sender);

  assert.equal(result, signature);
  assert.deepEqual(requests, [{ method: "secp256k1_sign", params: [kernelSigningHash] }]);
});

test("rejects malformed raw signatures before submission", async () => {
  const { signDirectUserOperation } = require("./direct-userop-client.ts") as typeof import("./direct-userop-client");
  await assert.rejects(
    signDirectUserOperation({ request: async () => "0x" }, userOpHash, sender),
    /invalid UserOperation signature/,
  );
  await assert.rejects(
    signDirectUserOperation({ request: async () => undefined }, userOpHash, sender),
    /invalid UserOperation signature/,
  );
});

test("invokes fallback only when prepare rejects before signing", async () => {
  let fallbackCalls = 0;
  let signCalls = 0;
  const result = await submitDirectUserOperationWithWallet({
    accessToken: "privy-token",
    chainId: 10_143,
    calls: [{ to: sender }],
    provider: {
      request: async () => {
        signCalls += 1;
        return `0x${"ab".repeat(65)}`;
      },
    },
    sender,
    onAccountNotDelegated: async () => {
      fallbackCalls += 1;
      return `0x${"56".repeat(32)}`;
    },
    fetchFn: async () =>
      new Response(JSON.stringify({ error: "Account is not delegated", code: "ACCOUNT_NOT_DELEGATED" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
  });
  assert.equal(result, `0x${"56".repeat(32)}`);
  assert.equal(fallbackCalls, 1);
  assert.equal(signCalls, 0);
});

test("does not fall back after signing has started", async () => {
  let requestCount = 0;
  let fallbackCalls = 0;
  await assert.rejects(
    submitDirectUserOperationWithWallet({
      accessToken: "privy-token",
      chainId: 10_143,
      calls: [{ to: sender }],
      provider: { request: async () => `0x${"ab".repeat(65)}` },
      sender,
      onAccountNotDelegated: async () => {
        fallbackCalls += 1;
        return `0x${"56".repeat(32)}`;
      },
      fetchFn: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(JSON.stringify({ operation, userOpHash }))
          : new Response(JSON.stringify({ error: "Account is not delegated", code: "ACCOUNT_NOT_DELEGATED" }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
            });
      },
    }),
    /Account is not delegated/,
  );
  assert.equal(requestCount, 2);
  assert.equal(fallbackCalls, 0);
});
