import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { clobContractsByChainId } from "../config/contracts.ts";

const CHAIN_ID = 31_337;
const rpcUrl = process.env.NEXT_PUBLIC_ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const factoryAddress = clobContractsByChainId[CHAIN_ID].factoryAddress;
const poolId =
  process.env.NEXT_PUBLIC_DEFAULT_POOL_ID ?? "0x940fa4f561e904023d97c99693c926e617384e35a8001be8c408a507c2d04645";
let exchangeAddress;
let baseAsset;
let quoteAsset;

const delayMs = Math.max(0, Number.parseInt(process.env.STRESS_DELAY_MS ?? "180", 10));
const levelCount = Math.min(50, Math.max(1, Number.parseInt(process.env.STRESS_LEVELS ?? "18", 10)));
const sweepCount = Math.min(20, Math.max(1, Number.parseInt(process.env.STRESS_SWEEPS ?? "8", 10)));

const privateKeys = {
  sellerA: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  sellerB: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  buyerA: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  buyerB: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};

const anvil = {
  id: CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const tokenAbi = parseAbi([
  "function mint(address account, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const factoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "pool",
        type: "tuple",
        components: [
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "book", type: "address" },
          { name: "lotSize", type: "uint128" },
          { name: "tickSize", type: "uint128" },
          { name: "minTick", type: "uint24" },
          { name: "maxTick", type: "uint24" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
];

const clobAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "placeLimitOrderWithMaxBookSteps",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "side", type: "uint8" },
          { name: "price", type: "uint128" },
          { name: "quantity", type: "uint128" },
          { name: "expiry", type: "uint64" },
          { name: "clientOrderId", type: "uint64" },
        ],
      },
      { name: "maxBookSteps", type: "uint32" },
    ],
    outputs: [{ name: "orderId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "executeMarketOrder",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "baseAsset", type: "address" },
          { name: "quoteAsset", type: "address" },
          { name: "side", type: "uint8" },
          { name: "quantity", type: "uint128" },
          { name: "priceLimit", type: "uint128" },
          { name: "minFillQuantity", type: "uint128" },
          { name: "clientOrderId", type: "uint64" },
        ],
      },
      { name: "maxBookSteps", type: "uint32" },
    ],
    outputs: [
      { name: "orderId", type: "bytes32" },
      { name: "filledQuantity", type: "uint128" },
      { name: "quoteQuantity", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getBestPrices",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "bidExists", type: "bool" },
      { name: "bidPrice", type: "uint128" },
      { name: "bidQuantity", type: "uint128" },
      { name: "askExists", type: "bool" },
      { name: "askPrice", type: "uint128" },
      { name: "askQuantity", type: "uint128" },
    ],
  },
];

const publicClient = createPublicClient({ chain: anvil, transport: http(rpcUrl) });
const actors = Object.fromEntries(
  Object.entries(privateKeys).map(([name, key]) => {
    const account = privateKeyToAccount(key);
    return [name, { account, wallet: createWalletClient({ account, chain: anvil, transport: http(rpcUrl) }) }];
  }),
);

const maxUint256 = (1n << 256n) - 1n;
let clientOrderId = BigInt(Date.now()) * 100n;
let transactionCount = 0;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function send(actor, request, label, pause = true) {
  const hash = await actor.wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  transactionCount += 1;
  console.log(`${String(transactionCount).padStart(3, "0")} ${label} · block ${receipt.blockNumber}`);
  if (pause && delayMs) await sleep(delayMs);
}

async function fundActor(actor, token, amount, label) {
  await send(
    actor,
    { address: token, abi: tokenAbi, functionName: "mint", args: [actor.account.address, amount] },
    `${label} mint`,
    false,
  );
  await send(
    actor,
    { address: token, abi: tokenAbi, functionName: "approve", args: [exchangeAddress, maxUint256] },
    `${label} approve`,
    false,
  );
  await send(
    actor,
    { address: exchangeAddress, abi: clobAbi, functionName: "deposit", args: [token, amount] },
    `${label} deposit`,
    false,
  );
}

async function place(actor, side, price, quantity, label) {
  clientOrderId += 1n;
  await send(
    actor,
    {
      address: exchangeAddress,
      abi: clobAbi,
      functionName: "placeLimitOrderWithMaxBookSteps",
      args: [
        {
          trader: actor.account.address,
          baseAsset,
          quoteAsset,
          side,
          price,
          quantity,
          expiry: 0n,
          clientOrderId,
        },
        128,
      ],
    },
    label,
  );
}

async function sweep(actor, side, quantity, label) {
  clientOrderId += 1n;
  await send(
    actor,
    {
      address: exchangeAddress,
      abi: clobAbi,
      functionName: "executeMarketOrder",
      args: [
        {
          trader: actor.account.address,
          baseAsset,
          quoteAsset,
          side,
          quantity,
          priceLimit: 0n,
          minFillQuantity: quantity,
          clientOrderId,
        },
        128,
      ],
    },
    label,
  );
}

function formatPrice(raw) {
  return (Number(raw) / 1_000_000).toFixed(3);
}

async function printTop(label) {
  const [, bidPrice, bidQuantity, , askPrice, askQuantity] = await publicClient.readContract({
    address: exchangeAddress,
    abi: clobAbi,
    functionName: "getBestPrices",
    args: [poolId],
  });
  console.log(
    `${label}: bid ${formatPrice(bidPrice)} × ${bidQuantity} | ask ${formatPrice(askPrice)} × ${askQuantity}`,
  );
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 31_337) throw new Error(`Refusing to run against chain ${chainId}; expected local Anvil 31337`);
  const pool = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "getPool",
    args: [poolId],
  });
  if (!pool.exists) throw new Error(`Factory ${factoryAddress} has no pair ${poolId}`);
  baseAsset = pool.baseAsset;
  quoteAsset = pool.quoteAsset;
  exchangeAddress = pool.book;
  const exchangeCode = await publicClient.getCode({ address: exchangeAddress });
  if (!exchangeCode || exchangeCode === "0x") throw new Error(`No SpotCLOB contract at ${exchangeAddress}`);

  console.log(
    `Live order-book stress on ${exchangeAddress}: ${levelCount} levels/side, ${sweepCount} alternating sweep rounds, ${delayMs}ms pacing`,
  );
  await printTop("Starting book");

  await fundActor(actors.sellerA, baseAsset, 100n * 10n ** 18n, "seller A");
  await fundActor(actors.sellerB, baseAsset, 100n * 10n ** 18n, "seller B");
  await fundActor(actors.buyerA, quoteAsset, 5_000n * 10n ** 6n, "buyer A");
  await fundActor(actors.buyerB, quoteAsset, 5_000n * 10n ** 6n, "buyer B");

  for (let index = 0; index < levelCount; index += 1) {
    const quantity = BigInt(1 + (index % 3));
    const seller = index % 2 === 0 ? actors.sellerA : actors.sellerB;
    const buyer = index % 2 === 0 ? actors.buyerA : actors.buyerB;
    await place(
      seller,
      1,
      431_000n + BigInt(index) * 1_000n,
      quantity,
      `ask ${formatPrice(431_000n + BigInt(index) * 1_000n)} × ${quantity}`,
    );
    await place(
      buyer,
      0,
      426_000n - BigInt(index) * 1_000n,
      quantity,
      `bid ${formatPrice(426_000n - BigInt(index) * 1_000n)} × ${quantity}`,
    );
  }

  await printTop("Depth loaded");
  for (let round = 0; round < sweepCount; round += 1) {
    const buyer = round % 2 === 0 ? actors.buyerA : actors.buyerB;
    const seller = round % 2 === 0 ? actors.sellerA : actors.sellerB;
    await sweep(buyer, 0, 2n, `market buy round ${round + 1}`);
    await printTop("After buy ");
    await sweep(seller, 1, 2n, `market sell round ${round + 1}`);
    await printTop("After sell");
  }

  console.log(
    `Complete: ${transactionCount} successful transactions. Refreshing the page preserves all event history.`,
  );
}

await main();
