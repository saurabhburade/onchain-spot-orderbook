import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PrivyClient } from "@privy-io/node";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  padHex,
  parseAbi,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 10_143;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const KERNEL_DELEGATE = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28";
const EIP_7702_PREFIX = "0xef0100";
const DEFAULT_POOL_ID = "0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c";
const DEFAULT_BOOK = "0x3d4e75ba9f53908345ce12951ee697B17A455E30";
const statePath = fileURLToPath(new URL("../.env.privy-market-maker-state.json", import.meta.url));

const entryPointAbi = parseAbi([
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address payable beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
]);

const kernelAbi = parseAbi(["function execute(bytes32 execMode,bytes executionCalldata) payable"]);
const clobAbi = parseAbi([
  "function getBestPrices(bytes32 poolId) view returns (bool bidExists,uint128 bidPrice,uint128 bidQuantity,bool askExists,uint128 askPrice,uint128 askQuantity)",
]);

const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});

export function packUint128Pair(high, low) {
  const maximum = (1n << 128n) - 1n;
  if (high < 0n || low < 0n || high > maximum || low > maximum) {
    throw new Error("Packed UserOperation gas values must fit into uint128");
  }
  return concatHex([padHex(toHex(high), { size: 16 }), padHex(toHex(low), { size: 16 })]);
}

export function encodeKernelSingleCall(target, data, value = 0n) {
  const executionCalldata = concatHex([getAddress(target), padHex(toHex(value), { size: 32 }), data]);
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [padHex("0x00", { size: 32 }), executionCalldata],
  });
}

export function packUserOperation(operation) {
  return {
    sender: getAddress(operation.sender),
    nonce: operation.nonce,
    initCode: "0x",
    callData: operation.callData,
    accountGasLimits: packUint128Pair(operation.verificationGasLimit, operation.callGasLimit),
    preVerificationGas: operation.preVerificationGas,
    gasFees: packUint128Pair(operation.maxPriorityFeePerGas, operation.maxFeePerGas),
    paymasterAndData: "0x",
    signature: operation.signature,
  };
}

function asPrivateKey(value, name) {
  if (!value) throw new Error(`${name} is missing`);
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${name} must be a 32-byte hex private key`);
  return key;
}

async function loadWallet() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const requestedAddress = process.env.USEROP_WALLET_ADDRESS?.toLowerCase();
  const wallet = requestedAddress
    ? state.wallets.find((candidate) => candidate.address?.toLowerCase() === requestedAddress)
    : state.wallets.at(-1);
  if (!wallet?.id || !wallet.address || !wallet.authorizationPrivateKey) {
    throw new Error("No usable Privy market-maker wallet was found");
  }
  return { ...wallet, address: getAddress(wallet.address) };
}

function randomNonceKey() {
  // Kernel's root validation mode occupies the leading two zero bytes. The
  // remaining 22 bytes give each independently submitted UserOp its own queue.
  return BigInt(`0x0000${randomBytes(22).toString("hex")}`);
}

function toPrivyUserOperation(operation) {
  return {
    sender: operation.sender,
    nonce: toHex(operation.nonce),
    call_data: operation.callData,
    call_gas_limit: toHex(operation.callGasLimit),
    verification_gas_limit: toHex(operation.verificationGasLimit),
    pre_verification_gas: toHex(operation.preVerificationGas),
    max_fee_per_gas: toHex(operation.maxFeePerGas),
    max_priority_fee_per_gas: toHex(operation.maxPriorityFeePerGas),
  };
}

function findUserOperationEvent(receipt, sender) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ENTRY_POINT.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics });
      if (event.eventName === "UserOperationEvent" && event.args.sender.toLowerCase() === sender.toLowerCase()) {
        return event.args;
      }
    } catch {
      // Ignore other EntryPoint events.
    }
  }
  return null;
}

function findTraceError(trace) {
  if (trace.error) return trace.error;
  for (const call of trace.calls ?? []) {
    const error = findTraceError(call);
    if (error) return error;
  }
  return null;
}

export async function main() {
  const appId = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Privy credentials are missing");

  const rpcUrl = process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
  const sponsor = privateKeyToAccount(asPrivateKey(process.env.SPONSER_PK, "SPONSER_PK"));
  const wallet = await loadWallet();
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: sponsor, chain: monadTestnet, transport: http(rpcUrl) });
  const privy = new PrivyClient({ appId, appSecret });

  const [chainId, delegatedCode, sponsorBalanceBefore, userBalanceBefore] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getCode({ address: wallet.address }),
    publicClient.getBalance({ address: sponsor.address }),
    publicClient.getBalance({ address: wallet.address }),
  ]);
  if (chainId !== CHAIN_ID) throw new Error(`Expected Monad Testnet ${CHAIN_ID}, received ${chainId}`);
  const expectedDelegation = `${EIP_7702_PREFIX}${KERNEL_DELEGATE.slice(2)}`.toLowerCase();
  if (delegatedCode?.toLowerCase() !== expectedDelegation) {
    throw new Error(`${wallet.address} is not delegated to the expected Kernel v3.3 implementation`);
  }

  const poolId = process.env.USEROP_POOL_ID ?? DEFAULT_POOL_ID;
  const book = getAddress(process.env.USEROP_BOOK_ADDRESS ?? DEFAULT_BOOK);
  const innerCall = encodeFunctionData({ abi: clobAbi, functionName: "getBestPrices", args: [poolId] });
  const callData = encodeKernelSingleCall(book, innerCall);
  const nonceKey = randomNonceKey();
  const nonce = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [wallet.address, nonceKey],
  });

  const unsignedOperation = {
    sender: wallet.address,
    nonce,
    callData,
    callGasLimit: 700_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
  };
  const signed = await privy
    .wallets()
    .ethereum()
    .signUserOperation(wallet.id, {
      params: {
        chain_id: CHAIN_ID,
        contract: KERNEL_DELEGATE,
        user_operation: toPrivyUserOperation(unsignedOperation),
      },
      authorization_context: { authorization_private_keys: [wallet.authorizationPrivateKey] },
      idempotency_key: randomUUID(),
      request_expiry: Date.now() + 60_000,
    });
  const operation = packUserOperation({ ...unsignedOperation, signature: signed.signature });
  const handleOpsData = encodeFunctionData({
    abi: entryPointAbi,
    functionName: "handleOps",
    args: [[operation], sponsor.address],
  });

  const estimatedGas = await publicClient.estimateGas({
    account: sponsor.address,
    to: ENTRY_POINT,
    data: handleOpsData,
  });
  const outerGasLimit = (estimatedGas * 110n) / 100n;
  const gasPrice = await publicClient.getGasPrice();
  const maximumCost = outerGasLimit * gasPrice;
  if (sponsorBalanceBefore < maximumCost) {
    throw new Error(
      `Sponsor has ${formatEther(sponsorBalanceBefore)} MON but needs up to ${formatEther(maximumCost)} MON`,
    );
  }

  await publicClient.call({ account: sponsor.address, to: ENTRY_POINT, data: handleOpsData, gas: outerGasLimit });
  const trace = await publicClient.request({
    method: "debug_traceCall",
    params: [
      { from: sponsor.address, to: ENTRY_POINT, data: handleOpsData, gas: toHex(outerGasLimit) },
      "latest",
      { tracer: "callTracer" },
    ],
  });
  const traceError = findTraceError(trace);
  if (traceError) throw new Error(`UserOperation trace failed before broadcast: ${traceError}`);
  console.log(
    JSON.stringify(
      {
        mode: process.argv.includes("--send") ? "send" : "simulation",
        sponsor: sponsor.address,
        user: wallet.address,
        entryPoint: ENTRY_POINT,
        paymaster: zeroAddress,
        userOpGasPrice: "0",
        estimatedOuterGas: estimatedGas.toString(),
        maximumOuterCostMon: formatEther(maximumCost),
        simulation: "passed",
      },
      null,
      2,
    ),
  );
  if (!process.argv.includes("--send")) return;

  const hash = await walletClient.sendTransaction({ to: ENTRY_POINT, data: handleOpsData, gas: outerGasLimit });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Outer transaction reverted: ${hash}`);
  const event = findUserOperationEvent(receipt, wallet.address);
  if (!event) throw new Error(`No UserOperationEvent found for ${wallet.address}`);
  if (!event.success) throw new Error(`UserOperation failed inside successful outer transaction: ${hash}`);
  if (event.paymaster !== zeroAddress || event.actualGasCost !== 0n) {
    throw new Error("The UserOperation unexpectedly charged a paymaster or the user account");
  }

  const [sponsorBalanceAfter, userBalanceAfter] = await Promise.all([
    publicClient.getBalance({ address: sponsor.address, blockNumber: receipt.blockNumber }),
    publicClient.getBalance({ address: wallet.address, blockNumber: receipt.blockNumber }),
  ]);
  console.log(
    JSON.stringify(
      {
        hash,
        blockNumber: receipt.blockNumber.toString(),
        outerGasUsed: receipt.gasUsed.toString(),
        sponsorPaidMon: formatEther(sponsorBalanceBefore - sponsorBalanceAfter),
        userBalanceBeforeMon: formatEther(userBalanceBefore),
        userBalanceAfterMon: formatEther(userBalanceAfter),
        userOperationSuccess: event.success,
        userOperationGasCost: event.actualGasCost.toString(),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
