import type { NextRequest } from "next/server";

import { authenticatePrivyRequest } from "@/lib/privy/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const TERMINAL_STATUSES = new Set([
  "confirmed",
  "execution_reverted",
  "failed",
  "replaced",
  "finalized",
  "provider_error",
]);

function validOpaqueId(value: string) {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function sseEvent(status: string, transactionHash: string | null) {
  return `event: status\ndata: ${JSON.stringify({ status, transactionHash })}\n\n`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ walletId: string; transactionId: string }> },
) {
  let privy: Awaited<ReturnType<typeof authenticatePrivyRequest>>;
  let walletId: string;
  let transactionId: string;
  try {
    [{ walletId, transactionId }, privy] = await Promise.all([params, authenticatePrivyRequest(request)]);
    if (!validOpaqueId(walletId) || !validOpaqueId(transactionId)) {
      return Response.json({ error: "Invalid Privy transaction reference" }, { status: 400 });
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to authenticate the Privy status stream" },
      { status: 401 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let lastHeartbeatAt = startedAt;
      let previousStatus = "";
      let previousHash: string | null = null;
      let pollCount = 0;
      try {
        while (!request.signal.aborted && Date.now() - startedAt < 55_000) {
          const transaction = await privy.transactions().get(transactionId);
          if (transaction.wallet_id !== walletId) throw new Error("Transaction does not belong to this Privy wallet");
          if (transaction.status !== previousStatus || transaction.transaction_hash !== previousHash) {
            controller.enqueue(encoder.encode(sseEvent(transaction.status, transaction.transaction_hash)));
            previousStatus = transaction.status;
            previousHash = transaction.transaction_hash;
          }
          if (Date.now() - lastHeartbeatAt >= 10_000) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            lastHeartbeatAt = Date.now();
          }
          if (TERMINAL_STATUSES.has(transaction.status)) {
            controller.close();
            return;
          }
          pollCount += 1;
          await new Promise((resolve) => setTimeout(resolve, pollCount <= 10 ? 500 : 1_000));
        }
        if (!request.signal.aborted) controller.enqueue(encoder.encode(sseEvent("timeout", null)));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Privy status polling failed";
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
