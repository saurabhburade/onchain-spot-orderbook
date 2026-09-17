import { type Address, type Hash, type Hex, isHash, toHex } from "viem";

import type { AtomicCall } from "./atomic-batch";

export const PRIVY_API_ORIGIN = "https://api.privy.io";

export type PrivyWalletCall = {
  to: Address;
  data?: Hex;
  value?: Hex;
};

export type PrivySendCallsBody = {
  method: "wallet_sendCalls";
  caip2: `eip155:${number}`;
  chain_type: "ethereum";
  sponsor: true;
  params: { calls: PrivyWalletCall[] };
};

export type PrivyTransactionEvent = {
  status:
    | "broadcasted"
    | "confirmed"
    | "execution_reverted"
    | "failed"
    | "replaced"
    | "finalized"
    | "provider_error"
    | "pending"
    | "timeout";
  transactionHash: string | null;
};

type GenerateAuthorizationSignature = (input: {
  version: 1;
  method: "POST";
  url: string;
  body: PrivySendCallsBody;
  headers: {
    "privy-app-id": string;
    "privy-idempotency-key": string;
    "privy-request-expiry": string;
  };
}) => Promise<{ signature: string }>;

export function privyWalletRpcUrl(walletId: string) {
  return `${PRIVY_API_ORIGIN}/v1/wallets/${walletId}/rpc`;
}

export function buildPrivySendCallsBody(chainId: number, calls: readonly AtomicCall[]): PrivySendCallsBody {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("A valid EVM chain ID is required");
  if (calls.length === 0) throw new Error("At least one wallet call is required");
  return {
    method: "wallet_sendCalls",
    caip2: `eip155:${chainId}`,
    chain_type: "ethereum",
    sponsor: true,
    params: {
      calls: calls.map(({ to, data, value }) => ({
        to,
        ...(data && data !== "0x" ? { data } : {}),
        ...(value && value > 0n ? { value: toHex(value) } : {}),
      })),
    },
  };
}

export async function sendPrivySponsoredCalls(input: {
  accessToken: string;
  calls: readonly AtomicCall[];
  chainId: number;
  generateAuthorizationSignature: GenerateAuthorizationSignature;
  walletId: string;
}) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) throw new Error("Privy is not configured");

  const request = buildPrivySendCallsBody(input.chainId, input.calls);
  const idempotencyKey = crypto.randomUUID();
  const requestExpiry = Date.now() + 60_000;
  const { signature } = await input.generateAuthorizationSignature({
    version: 1,
    method: "POST",
    url: privyWalletRpcUrl(input.walletId),
    body: request,
    headers: {
      "privy-app-id": appId,
      "privy-idempotency-key": idempotencyKey,
      "privy-request-expiry": String(requestExpiry),
    },
  });

  const response = await fetch(`/api/privy/wallets/${encodeURIComponent(input.walletId)}/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      request,
      signature,
      requestExpiry,
      idempotencyKey,
    }),
  });
  if (!response.ok) throw await responseError(response);
  const result = (await response.json()) as { transactionId?: unknown };
  if (typeof result.transactionId !== "string" || !result.transactionId) {
    throw new Error("Privy did not return a transaction ID");
  }
  return result.transactionId;
}

async function responseError(response: Response) {
  const fallback = `Privy request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return new Error(body.error ?? body.message ?? fallback);
  } catch {
    return new Error(fallback);
  }
}

function parseSseData(chunk: string): (PrivyTransactionEvent & { error?: string }) | null {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data) as PrivyTransactionEvent & { error?: string };
}

async function readStatusStream(response: Response): Promise<Hash | null> {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("Privy status stream returned no response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseSseData(frame);
      if (!event) continue;
      if (event.error) throw new Error(event.error);
      if (["execution_reverted", "failed", "replaced", "provider_error"].includes(event.status)) {
        throw new Error(`Privy transaction ${event.status.replaceAll("_", " ")}`);
      }
      if (event.transactionHash && isHash(event.transactionHash)) {
        await reader.cancel();
        return event.transactionHash;
      }
      if (event.status === "confirmed" || event.status === "finalized") {
        throw new Error("Privy confirmed the transaction without returning a transaction hash");
      }
      if (event.status === "timeout") return null;
    }
    if (done) return null;
  }
}

export async function waitForPrivyTransaction(input: {
  walletId: string;
  transactionId: string;
  getAccessToken: () => Promise<string | null>;
  signal?: AbortSignal;
}): Promise<Hash> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new DOMException("Transaction status tracking was cancelled", "AbortError");
    const accessToken = await input.getAccessToken();
    if (!accessToken) throw new Error("Your Privy session expired while tracking the transaction");
    const response = await fetch(
      `/api/privy/wallets/${encodeURIComponent(input.walletId)}/transactions/${encodeURIComponent(input.transactionId)}/events`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: input.signal,
      },
    );
    const hash = await readStatusStream(response);
    if (hash) return hash;
  }
  throw new Error("Timed out waiting for the Privy transaction to confirm");
}
