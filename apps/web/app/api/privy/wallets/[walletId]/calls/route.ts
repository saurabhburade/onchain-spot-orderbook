import type { NextRequest } from "next/server";
import { getClobNetwork, MONAD_TESTNET_CHAIN_ID } from "@/lib/clob/config";
import { validatePrivySponsoredBatch } from "@/lib/clob/privy-call-validation";
import { authenticatePrivyRequest } from "@/lib/privy/server";

export const runtime = "nodejs";

type SubmitBody = {
  request?: unknown;
  signature?: unknown;
  requestExpiry?: unknown;
  idempotencyKey?: unknown;
};

function validOpaqueId(value: string) {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Unable to submit the Privy wallet batch";
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ walletId: string }> }) {
  try {
    const [{ walletId }, privy, payload] = await Promise.all([
      params,
      authenticatePrivyRequest(request),
      request.json() as Promise<SubmitBody>,
    ]);
    if (!validOpaqueId(walletId)) return errorResponse(new Error("Invalid Privy wallet ID"));
    if (typeof payload.signature !== "string" || payload.signature.length < 16 || payload.signature.length > 4096) {
      return errorResponse(new Error("Missing or invalid Privy authorization signature"));
    }
    if (typeof payload.idempotencyKey !== "string" || !validOpaqueId(payload.idempotencyKey)) {
      return errorResponse(new Error("Missing or invalid idempotency key"));
    }
    if (typeof payload.requestExpiry !== "number" || !Number.isSafeInteger(payload.requestExpiry)) {
      return errorResponse(new Error("Missing or invalid request expiry"));
    }
    const now = Date.now();
    if (payload.requestExpiry <= now || payload.requestExpiry > now + 2 * 60_000) {
      return errorResponse(new Error("Privy request expiry is outside the permitted window"));
    }
    const network = getClobNetwork(MONAD_TESTNET_CHAIN_ID);
    const body = validatePrivySponsoredBatch(
      payload.request,
      MONAD_TESTNET_CHAIN_ID,
      network.faucetAddress
        ? {
            address: network.faucetAddress,
            tokens: network.faucetTokens.map((token) => token.address),
          }
        : undefined,
    );
    const result = await privy
      .wallets()
      .ethereum()
      .sendCalls(walletId, {
        caip2: body.caip2,
        params: body.params,
        sponsor: true,
        authorization_context: { signatures: [payload.signature] },
        idempotency_key: payload.idempotencyKey,
        request_expiry: payload.requestExpiry,
      });
    return Response.json(
      { transactionId: result.transaction_id, caip2: result.caip2 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    const status = message.includes("access token") || message.includes("auth token") ? 401 : 502;
    return errorResponse(error, status);
  }
}
