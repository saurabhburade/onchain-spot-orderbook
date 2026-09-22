import { performance } from "node:perf_hooks";

import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  hashTypedData,
  http,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { erc20Abi } from "../config/abis/erc20.ts";
import { tokenFaucetAbi } from "../config/abis/token.ts";
import { clobContractsByChainId } from "../config/contracts.ts";
import { prepareDirectUserOperation, submitDirectUserOperation } from "../lib/clob/direct-userop.ts";
import {
  createAppKernelPermissionConfiguration,
  encodeKernelV33PermissionEnableSignature,
  encodeKernelV33PermissionNonceKey,
  encodeKernelV33PermissionUserOpSignature,
  getKernelV33PermissionEnableTypedData,
  KERNEL_PERMISSION_MODE_DEFAULT,
  KERNEL_PERMISSION_MODE_ENABLE,
  KERNEL_V33_DELEGATE,
  MONAD_TESTNET_CHAIN_ID,
} from "../lib/clob/kernel-session-key.ts";

const rpcUrl = process.env.KERNEL_SESSION_FORK_RPC_URL ?? "http://127.0.0.1:8547";
const sponsorPrivateKey = process.env.SPONSER_PK;
if (!sponsorPrivateKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(sponsorPrivateKey)) {
  throw new Error("SPONSER_PK must be present and contain a 32-byte private key");
}

const chain = defineChain({
  id: MONAD_TESTNET_CHAIN_ID,
  name: "Monad testnet fork",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
// A cold fork lazily fetches several permission-module storage slots during the
// first estimate. Give the local verification harness time to populate them;
// production RPCs do not pay this one-off fork hydration cost.
const transport = http(rpcUrl, { retryCount: 0, timeout: 120_000 });
const sponsor = privateKeyToAccount(
  (sponsorPrivateKey.startsWith("0x") ? sponsorPrivateKey : `0x${sponsorPrivateKey}`) as Hex,
);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account: sponsor, chain, transport });
const owner = privateKeyToAccount(generatePrivateKey());
const session = privateKeyToAccount(generatePrivateKey());
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const contracts = clobContractsByChainId[MONAD_TESTNET_CHAIN_ID];

if (!contracts.faucetAddress || !contracts.faucetTokens[0]) {
  throw new Error("Monad faucet configuration is unavailable");
}
const faucetAddress = contracts.faucetAddress;
const token = contracts.faucetTokens[0];

type Timing = {
  prepareMs: number;
  localSignMs: number;
  submitToHashMs: number;
  totalMs: number;
  hash: Hash;
};

async function elapsed<T>(task: () => Promise<T>): Promise<[T, number]> {
  const startedAt = performance.now();
  const result = await task();
  return [result, Math.round(performance.now() - startedAt)];
}

async function sendPermissionUserOperation(input: {
  calls: readonly { to: Address; data: Hex; value?: bigint }[];
  mode: Hex;
  permissionId: Hex;
  signatureFor: (userOpSignature: Hex) => Hex;
}): Promise<Timing> {
  const totalStartedAt = performance.now();
  const nonceKey = encodeKernelV33PermissionNonceKey(input.permissionId, 0n, input.mode);
  const [prepared, prepareMs] = await elapsed(() =>
    prepareDirectUserOperation({
      sender: owner.address,
      calls: input.calls,
      nonceKey: `0x${nonceKey.toString(16)}`,
      publicClient,
    }),
  );
  const [rawSignature, localSignMs] = await elapsed(() =>
    session.signMessage({ message: { raw: prepared.userOpHash } }),
  );
  const signature = input.signatureFor(encodeKernelV33PermissionUserOpSignature(rawSignature));
  const [result, submitToHashMs] = await elapsed(() =>
    submitDirectUserOperation({
      calls: input.calls,
      operation: prepared.operation,
      signature,
      signatureMode: "kernel-permission",
      publicClient,
      walletClient,
    }),
  );
  return {
    prepareMs,
    localSignMs,
    submitToHashMs,
    totalMs: Math.round(performance.now() - totalStartedAt),
    hash: result.hash,
  };
}

const [authorization, authorizationSignMs] = await elapsed(() =>
  owner.signAuthorization({
    contractAddress: KERNEL_V33_DELEGATE,
    chainId: MONAD_TESTNET_CHAIN_ID,
    nonce: 0,
  }),
);
const delegationHash = await walletClient.sendTransaction({
  authorizationList: [authorization],
  to: sponsor.address,
  value: 0n,
});
await publicClient.waitForTransactionReceipt({ hash: delegationHash });
const delegatedCode = await publicClient.getCode({ address: owner.address });
if (delegatedCode?.toLowerCase() !== `0xef0100${KERNEL_V33_DELEGATE.slice(2)}`.toLowerCase()) {
  throw new Error(`EIP-7702 delegation failed: ${delegatedCode ?? "0x"}`);
}

const now = Math.floor(Date.now() / 1_000);
const permission = createAppKernelPermissionConfiguration({
  sessionKey: session.address,
  validAfter: now - 30,
});
const kernelNonceAbi = [
  {
    type: "function",
    name: "currentNonce",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
    stateMutability: "view",
  },
] as const;
const currentNonce = await publicClient.readContract({
  address: owner.address,
  abi: kernelNonceAbi,
  functionName: "currentNonce",
});
const typedData = getKernelV33PermissionEnableTypedData({
  account: owner.address,
  chainId: MONAD_TESTNET_CHAIN_ID,
  permissionId: permission.permissionId,
  validatorData: permission.validatorData,
  nonce: Number(currentNonce === 0 ? 1 : currentNonce),
});
const [enableSignature, enableSignMs] = await elapsed(() => owner.sign({ hash: hashTypedData(typedData) }));

const faucetCall = {
  to: getAddress(faucetAddress),
  data: encodeFunctionData({
    abi: tokenFaucetAbi,
    functionName: "claim",
    args: [token.address],
  }),
} as const;
const first = await sendPermissionUserOperation({
  calls: [faucetCall],
  mode: KERNEL_PERMISSION_MODE_ENABLE,
  permissionId: permission.permissionId,
  signatureFor: (userOpSignature) =>
    encodeKernelV33PermissionEnableSignature({
      validatorData: permission.validatorData,
      enableSignature,
      userOpSignature,
    }),
});
const firstReceipt = await publicClient.waitForTransactionReceipt({ hash: first.hash });
if (firstReceipt.status !== "success") throw new Error("First permission UserOperation reverted");

const transferCall = {
  to: getAddress(token.address),
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, 1n],
  }),
} as const;
const repeat = await sendPermissionUserOperation({
  calls: [transferCall],
  mode: KERNEL_PERMISSION_MODE_DEFAULT,
  permissionId: permission.permissionId,
  signatureFor: (userOpSignature) => userOpSignature,
});
const repeatReceipt = await publicClient.waitForTransactionReceipt({ hash: repeat.hash });
if (repeatReceipt.status !== "success") throw new Error("Repeat permission UserOperation reverted");

const recipientBalance = await publicClient.readContract({
  address: token.address,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [recipient],
});
if (recipientBalance !== 1n) throw new Error(`Unexpected recipient balance: ${recipientBalance}`);

console.log(
  JSON.stringify(
    {
      forkRpc: rpcUrl,
      owner: owner.address,
      sessionKey: session.address,
      delegation: { hash: delegationHash, localAuthorizationSignMs: authorizationSignMs },
      oneTimePermissionSetup: { localRootSignMs: enableSignMs },
      firstUse: first,
      repeatUse: repeat,
      recipientBalance: recipientBalance.toString(),
    },
    null,
    2,
  ),
);
