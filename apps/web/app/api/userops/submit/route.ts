import type { NextRequest } from "next/server";

import { DirectUserOperationError, submitDirectUserOperation } from "../../../../lib/clob/direct-userop";
import { authenticatePrivyRequest } from "../../../../lib/privy/server";

export const runtime = "nodejs";
export const maxDuration = 60;

function errorResponse(error: unknown) {
  if (error instanceof DirectUserOperationError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const message = error instanceof Error ? error.message : "Unable to submit UserOperation";
  const status = /access token|auth token/i.test(message) ? 401 : error instanceof SyntaxError ? 400 : 502;
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function parseBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DirectUserOperationError("Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "calls" && key !== "operation" && key !== "signature" && key !== "signatureMode") {
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
    const result = await submitDirectUserOperation({
      calls: body.calls,
      operation: body.operation,
      signature: body.signature,
      signatureMode: body.signatureMode,
    });
    const serverMs = Math.max(0, Math.round(performance.now() - serverStartedAt));
    const timing = { ...result.timing, authMs, serverMs };
    console.info("UserOperation submit latency", timing);
    return Response.json({ ...result, timing }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
