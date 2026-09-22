import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Hex } from "viem";

import {
  clearKernelSessionKey,
  prepareKernelSessionKey,
  submitDirectUserOperationWithSessionKey,
} from "./kernel-session-client.ts";

const sender = "0x1111111111111111111111111111111111111111" as const;
const call = { to: sender, data: "0xabcdef" as Hex };
const kernelSessionClientSource = readFileSync(new URL("./kernel-session-client.ts", import.meta.url), "utf8");
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

test("creates and renews sessions outside the trade path, then signs trades locally", async () => {
  clearKernelSessionKey();
  const originalNow = Date.now;
  let nowMs = originalNow();
  Date.now = () => nowMs;
  let rootSignCalls = 0;
  const submittedBodies: Array<Record<string, unknown>> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(request).endsWith("/prepare")) {
      throw new Error("session preparation must not call the API");
    }
    submittedBodies.push(body);
    return new Response(JSON.stringify({ hash: `0x${"34".repeat(32)}`, timing: submitServerTiming }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const provider = {
    request: async () => {
      rootSignCalls += 1;
      return `0x${"ab".repeat(64)}1b`;
    },
  };
  const publicClient = { readContract: async () => 1 } as never;

  try {
    await assert.rejects(
      () =>
        submitDirectUserOperationWithSessionKey({
          accessToken: "privy-token",
          chainId: 10_143,
          calls: [call],
          sender,
          fetchFn,
        }),
      /local signing session is not ready/,
    );
    const loginSetup = await prepareKernelSessionKey({
      chainId: 10_143,
      owner: sender,
      provider,
      publicClient,
    });
    const first = await submitDirectUserOperationWithSessionKey({
      accessToken: "privy-token",
      chainId: 10_143,
      calls: [call],
      sender,
      fetchFn,
    });
    const second = await submitDirectUserOperationWithSessionKey({
      accessToken: "privy-token",
      chainId: 10_143,
      calls: [call],
      sender,
      fetchFn,
    });
    const third = await submitDirectUserOperationWithSessionKey({
      accessToken: "privy-token",
      chainId: 10_143,
      calls: [call],
      sender,
      fetchFn,
    });
    nowMs += 25 * 60 * 60 * 1_000;
    await assert.rejects(
      () =>
        submitDirectUserOperationWithSessionKey({
          accessToken: "privy-token",
          chainId: 10_143,
          calls: [call],
          sender,
          fetchFn,
        }),
      /local signing session is not ready/,
    );
    const backgroundRenewal = await prepareKernelSessionKey({
      chainId: 10_143,
      owner: sender,
      provider,
      publicClient,
    });
    const renewed = await submitDirectUserOperationWithSessionKey({
      accessToken: "privy-token",
      chainId: 10_143,
      calls: [call],
      sender,
      fetchFn,
    });

    assert.equal(loginSetup.created, true);
    assert.equal(backgroundRenewal.created, true);
    assert.equal(rootSignCalls, 2);
    assert.equal(first.hash, `0x${"34".repeat(32)}`);
    assert.equal(second.hash, first.hash);
    assert.equal(third.hash, first.hash);
    assert.equal(renewed.hash, first.hash);
    assert.equal(first.metrics.setupMs, 0);
    assert.equal(second.metrics.setupMs, 0);
    assert.equal(renewed.metrics.setupMs, 0);
    assert.ok(first.metrics.signMs >= 0);
    assert.deepEqual(first.metrics.submitBreakdown, {
      ...submitServerTiming,
      networkMs: first.metrics.submitBreakdown?.networkMs,
      responseMs: first.metrics.submitBreakdown?.responseMs,
    });
    assert.ok((first.metrics.submitBreakdown?.networkMs ?? -1) >= 0);
    assert.ok((first.metrics.submitBreakdown?.responseMs ?? -1) >= 0);
    assert.ok(second.metrics.signMs >= 0);
    assert.ok(third.metrics.signMs >= 0);
    const submittedNonces = submittedBodies.map((body) => {
      const operation = body.operation as { nonce: string };
      return BigInt(operation.nonce);
    });
    const firstNonceKey = submittedNonces[0] >> 64n;
    const secondNonceKey = submittedNonces[1] >> 64n;
    const thirdNonceKey = submittedNonces[2] >> 64n;
    const renewedNonceKey = submittedNonces[3] >> 64n;
    assert.equal(Number(firstNonceKey >> 184n), 1);
    assert.equal(Number((firstNonceKey >> 176n) & 0xffn), 2);
    assert.equal(Number(secondNonceKey >> 184n), 0);
    assert.equal(Number((secondNonceKey >> 176n) & 0xffn), 2);
    assert.equal(Number(thirdNonceKey >> 184n), 0);
    assert.equal(Number((thirdNonceKey >> 176n) & 0xffn), 2);
    assert.equal(Number(renewedNonceKey >> 184n), 1);
    assert.equal(Number((renewedNonceKey >> 176n) & 0xffn), 2);
    assert.deepEqual(
      submittedNonces.map((nonce) => `0x${(nonce & ((1n << 64n) - 1n)).toString(16)}`),
      ["0x0", "0x0", "0x1", "0x0"],
    );
    assert.equal(submittedBodies[0]?.signatureMode, "kernel-permission");
    assert.equal(submittedBodies[1]?.signatureMode, "kernel-permission");
    assert.equal(submittedBodies[2]?.signatureMode, "kernel-permission");
    assert.equal(submittedBodies[3]?.signatureMode, "kernel-permission");
    assert.ok(String(submittedBodies[0]?.signature).length > String(submittedBodies[1]?.signature).length);
    assert.ok(String(submittedBodies[3]?.signature).length > String(submittedBodies[1]?.signature).length);
  } finally {
    Date.now = originalNow;
    clearKernelSessionKey();
  }
});

test("never initiates Privy session authorization from transaction submission", () => {
  const submitSource =
    kernelSessionClientSource.split("export async function submitDirectUserOperationWithSessionKey")[1] ?? "";

  assert.match(submitSource, /getPreparedSession/);
  assert.doesNotMatch(submitSource, /getOrCreateSession|createSession|rootSignHash|input\.provider/);
});
