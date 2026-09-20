import { type Address, decodeFunctionData, getAddress, type Hex, isAddress, isHex } from "viem";

import type { PrivySendCallsBody, PrivyWalletCall } from "./privy-wallet-api";

const MAX_CALLS = 3;
const MAX_CALLDATA_HEX_LENGTH = 300_002;
const APPROVE_SELECTOR = "0x095ea7b3";
const TRANSFER_SELECTOR = "0xa9059cbb";
// Derived from the deployed CLOB ABI. Keeping this allowlist narrow prevents
// the server-side sponsor route from becoming a generic contract-call proxy.
const ORDER_SELECTORS = new Set(["0x4fd0d46e", "0xee71e6e4", "0x7489ec23"]);
const approveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
const claimAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
] as const;
const transferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function isZeroValue(value: unknown) {
  if (value === undefined) return true;
  return typeof value === "string" && /^0x0*$/i.test(value);
}

function normalizeCall(value: unknown): PrivyWalletCall {
  if (!value || typeof value !== "object") throw new Error("Each wallet call must be an object");
  const call = value as { to?: unknown; data?: unknown; value?: unknown };
  if (typeof call.to !== "string" || !isAddress(call.to))
    throw new Error("Each wallet call requires a valid target address");
  if (call.data !== undefined && (typeof call.data !== "string" || !isHex(call.data))) {
    throw new Error("Wallet call data must be hex encoded");
  }
  if (typeof call.data === "string" && call.data.length > MAX_CALLDATA_HEX_LENGTH) {
    throw new Error("Wallet call data is too large");
  }
  if (!isZeroValue(call.value)) throw new Error("Native value transfers are not permitted in order batches");
  return {
    // Preserve the client's exact casing because the authorization signature
    // covers the canonicalized request body sent to Privy.
    to: call.to as Address,
    ...(call.data ? { data: call.data as Hex } : {}),
  };
}

export function validateOrderCalls(rawCalls: unknown): PrivyWalletCall[] {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0 || rawCalls.length > MAX_CALLS) {
    throw new Error(`Order batches must contain between 1 and ${MAX_CALLS} calls`);
  }
  const calls = rawCalls.map(normalizeCall);

  let orderTarget: Address | null = null;
  const approvals: Array<{ spender: Address }> = [];
  for (const call of calls) {
    if (!call.data) throw new Error("Every order-batch call must contain calldata");
    const selector = call.data.slice(0, 10).toLowerCase();
    if (ORDER_SELECTORS.has(selector)) {
      if (orderTarget) throw new Error("An order batch may contain only one order-book call");
      orderTarget = call.to;
      continue;
    }

    if (selector !== APPROVE_SELECTOR) {
      throw new Error("Order batches may contain only ERC-20 approvals and one order-book call");
    }
    try {
      const decoded = decodeFunctionData({ abi: approveAbi, data: call.data });
      const [spender] = decoded.args;
      approvals.push({ spender: getAddress(spender) });
    } catch {
      throw new Error("Order batches may contain only ERC-20 approvals and one order-book call");
    }
  }

  if (!orderTarget) throw new Error("The batch does not contain an order-book call");
  if (approvals.some(({ spender }) => spender.toLowerCase() !== orderTarget.toLowerCase())) {
    throw new Error("Every approval must target the order-book contract in the same batch");
  }
  return calls;
}

export function validateSponsoredCalls(
  rawCalls: unknown,
  faucet?: { address: Address; tokens: readonly Address[] },
  withdrawalTokens: readonly Address[] = [],
): PrivyWalletCall[] {
  if (faucet && Array.isArray(rawCalls) && rawCalls.length === 1) {
    const [call] = rawCalls.map(normalizeCall);
    if (call && call.to.toLowerCase() === faucet.address.toLowerCase() && call.data) {
      try {
        const decoded = decodeFunctionData({ abi: claimAbi, data: call.data });
        const [token] = decoded.args;
        if (!faucet.tokens.some((allowed) => allowed.toLowerCase() === token.toLowerCase())) {
          throw new Error("The faucet token is not allowlisted");
        }
        return [call];
      } catch (error) {
        if (error instanceof Error && error.message === "The faucet token is not allowlisted") throw error;
        throw new Error("Only the configured faucet claim is permitted outside CLOB order batches");
      }
    }
  }

  if (Array.isArray(rawCalls) && rawCalls.length === 1) {
    const [call] = rawCalls.map(normalizeCall);
    if (
      call?.data &&
      call.data.slice(0, 10).toLowerCase() === TRANSFER_SELECTOR &&
      withdrawalTokens.some((token) => token.toLowerCase() === call.to.toLowerCase())
    ) {
      try {
        const decoded = decodeFunctionData({ abi: transferAbi, data: call.data });
        const [, amount] = decoded.args;
        if (amount <= 0n) throw new Error("Withdrawal amount must be greater than zero");
        return [call];
      } catch (error) {
        if (error instanceof Error && error.message === "Withdrawal amount must be greater than zero") throw error;
        throw new Error("Only ERC-20 transfers of configured assets may be sponsored");
      }
    }
  }
  return validateOrderCalls(rawCalls);
}

export function validatePrivySponsoredBatch(
  value: unknown,
  expectedChainId: number,
  faucet?: { address: Address; tokens: readonly Address[] },
  withdrawalTokens: readonly Address[] = [],
): PrivySendCallsBody {
  if (!value || typeof value !== "object") throw new Error("Missing wallet_sendCalls request");
  const body = value as Partial<PrivySendCallsBody>;
  if (body.method !== "wallet_sendCalls" || body.chain_type !== "ethereum" || body.sponsor !== true) {
    throw new Error("Only sponsored Ethereum wallet_sendCalls requests are permitted");
  }
  if (body.caip2 !== `eip155:${expectedChainId}`) throw new Error("The wallet batch targets an unsupported chain");
  const calls = validateSponsoredCalls(body.params?.calls, faucet, withdrawalTokens);
  return {
    method: "wallet_sendCalls",
    caip2: `eip155:${expectedChainId}`,
    chain_type: "ethereum",
    sponsor: true,
    params: { calls },
  };
}

export function validatePrivyOrderBatch(value: unknown, expectedChainId: number): PrivySendCallsBody {
  return validatePrivySponsoredBatch(value, expectedChainId);
}
