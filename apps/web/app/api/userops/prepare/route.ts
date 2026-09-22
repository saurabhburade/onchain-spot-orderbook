import type { NextRequest } from "next/server";

import { DirectUserOperationError, prepareDirectUserOperation } from "../../../../lib/clob/direct-userop";
import { authenticatePrivyRequest } from "../../../../lib/privy/server";

export const runtime = "nodejs";
export const maxDuration = 60;

function errorResponse(error: unknown) {
  if (error instanceof DirectUserOperationError) {
    return Response.json(
      { error: error.message, ...(error.code === "ACCOUNT_NOT_DELEGATED" ? { code: error.code } : {}) },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const message = error instanceof Error ? error.message : "Unable to prepare UserOperation";
  const status = /access token|auth token/i.test(message) ? 401 : error instanceof SyntaxError ? 400 : 502;
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function parseBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DirectUserOperationError("Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "sender" && key !== "calls" && key !== "nonceKey" && key !== "nonceSequence") {
      throw new DirectUserOperationError(`Request body contains an unsupported field: ${key}`);
    }
  }
  return body;
}

export async function POST(request: NextRequest) {
  const serverStartedAt = performance.now();
  try {
    const authStartedAt = performance.now();
    await authenticatePrivyRequest(request);
    const authMs = Math.max(0, Math.round(performance.now() - authStartedAt));
    const body = parseBody(await request.json());
    const result = await prepareDirectUserOperation({
      sender: body.sender,
      calls: body.calls,
      nonceKey: body.nonceKey,
      nonceSequence: body.nonceSequence,
    });
    const serverMs = Math.max(0, Math.round(performance.now() - serverStartedAt));
    return Response.json(
      { ...result, timing: { ...result.timing, authMs, serverMs } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
