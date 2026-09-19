import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PrivyClient } from "@privy-io/node";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";

import { clobContractsByChainId } from "../config/contracts.ts";

const CHAIN_ID = 10_143;
const CAIP2 = `eip155:${CHAIN_ID}`;
const contracts = clobContractsByChainId[CHAIN_ID];
const usdcAddress = contracts.faucetTokens.find((token) => token.symbol === "USDC")?.address;

if (!contracts.factoryAddress || !contracts.tokenFactoryAddress || !contracts.faucetAddress || !usdcAddress) {
  throw new Error(`Incomplete contract configuration for chain ${CHAIN_ID}`);
}

const FACTORY = getAddress(contracts.factoryAddress);
const TOKEN_FACTORY = getAddress(contracts.tokenFactoryAddress);
const FAUCET = getAddress(contracts.faucetAddress);
const USDC = getAddress(usdcAddress);
const APP_ID = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";

const TOKEN_NAME = process.env.SEED_TOKEN_NAME ?? "Orderbook Demo";
const TOKEN_SYMBOL = process.env.SEED_TOKEN_SYMBOL ?? "BOOK";
const TOKEN_DECIMALS = 18;
const LOT_SIZE = 10n ** 18n;
const TICK_SIZE = 1_000n;
const MIN_TICK = 1;
const MAX_TICK = 10_000;
const CENTER_PRICE = 1_000_000n;
const BID_COUNT = 50;
const ASK_COUNT = 50;
const MAX_UINT256 = (1n << 256n) - 1n;
const BASE_FUNDING = 2_000n * 10n ** 18n;
const MIN_QUOTE_BALANCE = 500n * 10n ** 6n;
const force = process.argv.includes("--force");

const walletStatePath = fileURLToPath(new URL("../.env.privy-stress-state.json", import.meta.url));
const marketStatePath = fileURLToPath(new URL("../../../contracts/seeded-market-state.json", import.meta.url));

if (!APP_ID || !APP_SECRET) {
  throw new Error("Set NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) and PRIVY_APP_SECRET");
}

const chain = {
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const privy = new PrivyClient({ appId: APP_ID, appSecret: APP_SECRET });

const tokenFactoryAbi = parseAbi([
  "function createToken(string name, string symbol, uint8 decimals, uint256 initialSupply) returns (address token)",
  "event TokenCreated(address indexed creator, address indexed token, string name, string symbol, uint8 decimals, uint256 initialSupply)",
]);
const tokenAbi = parseAbi([
  "function owner() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);
const faucetAbi = parseAbi(["function claim(address token)"]);
const factoryAbi = parseAbi([
  "function createPair(address baseAsset, address quoteAsset, uint128 lotSize, uint128 tickSize, uint24 minTick, uint24 maxTick) returns (bytes32 id, address book)",
  "function getPool(bytes32 id) view returns ((address baseAsset, address quoteAsset, address book, uint128 lotSize, uint128 tickSize, uint24 minTick, uint24 maxTick, bool exists) pool)",
]);
const clobAbi = parseAbi([
  "function placeLimitOrderWithMaxBookSteps((address trader,address baseAsset,address quoteAsset,uint8 side,uint128 price,uint128 quantity,uint64 expiry,uint64 clientOrderId) order,uint32 maxBookSteps) returns (bytes32 orderId)",
  "function getBestPrices(bytes32 poolId) view returns (bool bidExists,uint128 bidPrice,uint128 bidQuantity,bool askExists,uint128 askPrice,uint128 askQuantity)",
  "function getUserOrderIds(bytes32 poolId,address trader,bytes32 cursor,uint16 limit,uint8 statusFlags) view returns (bytes32[] orderIds,bytes32 nextCursor)",
]);

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveMarketState(state) {
  await writeFile(marketStatePath, `${stringify(state)}\n`, { mode: 0o600 });
  await chmod(marketStatePath, 0o600);
}

async function waitForPrivyTransaction(transactionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transaction = await privy.transactions().get(transactionId);
    if (["execution_reverted", "failed", "provider_error", "replaced"].includes(transaction.status)) {
      throw new Error(`Privy transaction ${transactionId} ${transaction.status}`);
    }
    if (["broadcasted", "confirmed", "finalized"].includes(transaction.status) && transaction.transaction_hash) {
      return transaction;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Privy transaction ${transactionId}`);
}

async function sendSponsored(wallet, calls, label) {
  const startedAt = performance.now();
  const result = await privy
    .wallets()
    .ethereum()
    .sendCalls(wallet.id, {
      caip2: CAIP2,
      params: { calls },
      sponsor: true,
      authorization_context: { authorization_private_keys: [wallet.authorizationPrivateKey] },
      idempotency_key: randomUUID(),
      request_expiry: Date.now() + 60_000,
    });
  const transaction = await waitForPrivyTransaction(result.transaction_id);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transaction.transaction_hash,
    timeout: 180_000,
  });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${receipt.transactionHash}`);
  console.log(`${label} · ${receipt.transactionHash} · ${Math.round(performance.now() - startedAt)}ms`);
  return receipt;
}

async function runParallel(label, jobs) {
  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${label}: ${failures.map((failure) => String(failure.reason)).join("; ")}`,
    );
  }
  return settled.map((result) => result.value);
}

async function assertContract(address, label) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no contract code at ${address}`);
}

async function loadWallets() {
  const state = await readJson(walletStatePath);
  if (state?.version !== 1 || state.appId !== APP_ID || !Array.isArray(state.wallets)) {
    throw new Error("Run pnpm stress:privy -- --provision-only before seeding a demo market");
  }
  const wallets = state.wallets.filter((wallet) => wallet.id && wallet.address && wallet.authorizationPrivateKey);
  if (wallets.length < 5) throw new Error("Five provisioned Privy stress wallets are required");
  return wallets.slice(0, 5).map((wallet) => ({ ...wallet, address: getAddress(wallet.address) }));
}

async function provisionToken(owner, existingState) {
  if (existingState?.token) {
    const token = getAddress(existingState.token);
    const code = await publicClient.getCode({ address: token });
    if (code && code !== "0x") return token;
  }

  const receipt = await sendSponsored(
    owner,
    [
      {
        to: TOKEN_FACTORY,
        data: encodeFunctionData({
          abi: tokenFactoryAbi,
          functionName: "createToken",
          args: [TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS, 1_000_000n * 10n ** 18n],
        }),
      },
    ],
    `create ${TOKEN_SYMBOL}`,
  );
  for (const log of receipt.logs) {
    try {
      const event = decodeEventLog({ abi: tokenFactoryAbi, data: log.data, topics: log.topics });
      if (event.eventName === "TokenCreated") return getAddress(event.args.token);
    } catch {
      // Ignore logs emitted by other contracts in the sponsored transaction.
    }
  }
  throw new Error("TokenCreated event was not found");
}

async function provisionMarket(owner, token) {
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters("address, address"), [token, USDC]));
  let pool = await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [poolId],
  });
  if (!pool.exists) {
    await sendSponsored(
      owner,
      [
        {
          to: FACTORY,
          data: encodeFunctionData({
            abi: factoryAbi,
            functionName: "createPair",
            args: [token, USDC, LOT_SIZE, TICK_SIZE, MIN_TICK, MAX_TICK],
          }),
        },
      ],
      `create ${TOKEN_SYMBOL}/USDC market`,
    );
    pool = await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [poolId],
    });
  }
  if (!pool.exists) throw new Error("Factory did not register the seeded market");
  return { poolId, book: getAddress(pool.book) };
}

async function fundWallets(wallets, token) {
  const owner = wallets[0];
  const tokenOwner = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "owner" });
  if (tokenOwner.toLowerCase() !== owner.address.toLowerCase())
    throw new Error(`${TOKEN_SYMBOL} is not owned by stress wallet 1`);

  const tokenBalances = await Promise.all(
    wallets.map((wallet) =>
      publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [wallet.address] }),
    ),
  );
  const mintCalls = wallets.flatMap((wallet, index) =>
    tokenBalances[index] < BASE_FUNDING / 4n
      ? [
          {
            to: token,
            data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [wallet.address, BASE_FUNDING] }),
          },
        ]
      : [],
  );
  if (mintCalls.length) await sendSponsored(owner, mintCalls, `fund traders with ${TOKEN_SYMBOL}`);

  const quoteBalances = await Promise.all(
    wallets.map((wallet) =>
      publicClient.readContract({ address: USDC, abi: tokenAbi, functionName: "balanceOf", args: [wallet.address] }),
    ),
  );
  await runParallel(
    "USDC funding",
    wallets.flatMap((wallet, index) =>
      quoteBalances[index] < MIN_QUOTE_BALANCE
        ? [
            sendSponsored(
              wallet,
              [
                {
                  to: FAUCET,
                  data: encodeFunctionData({ abi: faucetAbi, functionName: "claim", args: [USDC] }),
                },
              ],
              `fund trader ${index + 1} with USDC`,
            ),
          ]
        : [],
    ),
  );
}

async function approveBook(wallets, token, book) {
  await runParallel(
    "book approvals",
    wallets.map(async (wallet, index) => {
      const calls = [];
      for (const asset of [token, USDC]) {
        const allowance = await publicClient.readContract({
          address: asset,
          abi: tokenAbi,
          functionName: "allowance",
          args: [wallet.address, book],
        });
        if (allowance < BASE_FUNDING / 4n)
          calls.push({
            to: asset,
            data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [book, MAX_UINT256] }),
          });
      }
      if (!calls.length) return null;
      return sendSponsored(wallet, calls, `approve trader ${index + 1}`);
    }),
  );
}

function limitOrderCall(wallet, token, book, side, price, quantity, clientOrderId) {
  return {
    to: book,
    data: encodeFunctionData({
      abi: clobAbi,
      functionName: "placeLimitOrderWithMaxBookSteps",
      args: [
        {
          trader: wallet.address,
          baseAsset: token,
          quoteAsset: USDC,
          side,
          price,
          quantity,
          expiry: 0n,
          clientOrderId,
        },
        128,
      ],
    }),
  };
}

async function readOpenOrderCount(wallet, market) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const [orderIds] = await publicClient.readContract({
        address: market.book,
        abi: clobAbi,
        functionName: "getUserOrderIds",
        args: [market.poolId, wallet.address, `0x${"00".repeat(32)}`, 100, 1],
      });
      return orderIds.length;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(750 * (attempt + 1));
    }
  }
  throw new Error("Unable to read open-order count");
}

async function seedBook(wallets, token, market, baselineOpenCounts, levelOffset) {
  const startedAt = Date.now();
  const openCounts = [];
  for (const wallet of wallets) {
    openCounts.push(await readOpenOrderCount(wallet, market));
    await sleep(100);
  }
  for (let wave = 0; wave < 5; wave += 1) {
    await runParallel(
      `order wave ${wave + 1}`,
      wallets.flatMap((wallet, walletIndex) => {
        if (openCounts[walletIndex] >= baselineOpenCounts[walletIndex] + (wave + 1) * 4) return [];
        const calls = [];
        for (let offset = 0; offset < 2; offset += 1) {
          const level = levelOffset + wave * 10 + walletIndex * 2 + offset;
          const quantity = BigInt(1 + (level % 5));
          const idBase = BigInt(startedAt) * 1_000n + BigInt(level) * 2n;
          calls.push(
            limitOrderCall(
              wallet,
              token,
              market.book,
              0,
              CENTER_PRICE - BigInt(level + 1) * TICK_SIZE,
              quantity,
              idBase,
            ),
          );
          calls.push(
            limitOrderCall(
              wallet,
              token,
              market.book,
              1,
              CENTER_PRICE + BigInt(level + 1) * TICK_SIZE,
              quantity,
              idBase + 1n,
            ),
          );
        }
        return [sendSponsored(wallet, calls, `wave ${wave + 1} trader ${walletIndex + 1}`)];
      }),
    );
  }
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Refusing to run on chain ${chainId}; expected ${CHAIN_ID}`);
  await Promise.all([
    assertContract(FACTORY, "SpotCLOBFactory"),
    assertContract(TOKEN_FACTORY, "ERC20TokenFactory"),
    assertContract(FAUCET, "TokenFaucet"),
    assertContract(USDC, "USDC"),
  ]);

  const wallets = await loadWallets();
  const existingState = await readJson(marketStatePath);
  const token = await provisionToken(wallets[0], existingState);
  const market = await provisionMarket(wallets[0], token);
  await saveMarketState({
    version: 1,
    chainId: CHAIN_ID,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    token,
    quoteToken: USDC,
    ...market,
    bids: existingState?.bids ?? 0,
    asks: existingState?.asks ?? 0,
    openOrdersByWallet: existingState?.openOrdersByWallet,
  });

  await fundWallets(wallets, token);
  await approveBook(wallets, token, market.book);
  const shouldSeed = !((existingState?.bids || existingState?.asks) && !force);
  let baselineOpenCounts = existingState?.openOrdersByWallet;
  if (!Array.isArray(baselineOpenCounts) || baselineOpenCounts.length !== wallets.length) {
    const uniformBaseline = Math.floor(((existingState?.bids ?? 0) + (existingState?.asks ?? 0)) / wallets.length);
    baselineOpenCounts = wallets.map(() => uniformBaseline);
  }
  if (!shouldSeed) {
    console.log(
      `Book already seeded with ${existingState.bids} bids and ${existingState.asks} asks; pass --force to add another ladder.`,
    );
  } else {
    await seedBook(wallets, token, market, baselineOpenCounts, existingState?.bids ?? 0);
  }

  const bestPrices = await publicClient.readContract({
    address: market.book,
    abi: clobAbi,
    functionName: "getBestPrices",
    args: [market.poolId],
  });
  const state = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    token,
    quoteToken: USDC,
    ...market,
    bids: existingState?.bids && !force ? existingState.bids : (existingState?.bids ?? 0) + BID_COUNT,
    asks: existingState?.asks && !force ? existingState.asks : (existingState?.asks ?? 0) + ASK_COUNT,
    openOrdersByWallet: shouldSeed
      ? baselineOpenCounts.map((count) => count + (BID_COUNT + ASK_COUNT) / wallets.length)
      : baselineOpenCounts,
    bestBid: bestPrices[1],
    bestAsk: bestPrices[4],
  };
  await saveMarketState(state);
  console.log(`SEEDED_MARKET=${stringify(state)}`);
}

await main();
