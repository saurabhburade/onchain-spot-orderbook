import type { NextRequest } from "next/server";

import { authenticatePrivyRequest } from "../../../../lib/privy/server";

export const runtime = "nodejs";
const logTransactionLatency = process.env.NODE_ENV !== "production";

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  try {
    await authenticatePrivyRequest(request);
    const authMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (logTransactionLatency) console.info("UserOperation auth warm latency", { authMs });
    return Response.json({ ok: true, authMs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to authenticate the Privy session";
    return Response.json({ error: message }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
}
