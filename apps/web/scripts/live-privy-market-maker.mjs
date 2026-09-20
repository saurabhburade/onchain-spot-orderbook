import { randomInt, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateP256KeyPair, PrivyClient } from "@privy-io/node";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
} from "viem";

import { clobContractsByChainId } from "../config/contracts.ts";

const CHAIN_ID = 10_143;
const CAIP2 = `eip155:${CHAIN_ID}`;
const ACCOUNT_COUNT = 5;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAX_UINT256 = (1n << 256n) - 1n;

const contracts = clobContractsByChainId[CHAIN_ID];
const DEFAULT_POOL_ID = "0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c";
const DEFAULT_FACTORY = contracts.factoryAddress;
const DEFAULT_FAUCET = contracts.faucetAddress;
const DEFAULT_USDC = contracts.faucetTokens.find((token) => token.symbol === "USDC")?.address;
const DEFAULT_USDT = contracts.faucetTokens.find((token) => token.symbol === "USDT")?.address;

if (!DEFAULT_FACTORY || !DEFAULT_FAUCET || !DEFAULT_USDC || !DEFAULT_USDT) {
  throw new Error(`Incomplete contract configuration for chain ${CHAIN_ID}`);
}
const DEFAULT_RPC_URLS = [
  "https://testnet-rpc.monad.xyz",
  "https://rpc.ankr.com/monad_testnet",
  "https://rpc-testnet.monadinfra.com",
  "https://monad-testnet.drpc.org",
  "https://lb.routeme.sh/rpc/evm/10143",
  "https://monad-testnet.gateway.tatum.io",
  "https://monad-testnet-rpc.huginn.tech",
];

const statePath = fileURLToPath(new URL("../.env.privy-market-maker-state.json", import.meta.url));
const reportPath = fileURLToPath(new URL("../.env.privy-market-maker-report.json", import.meta.url));

const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const faucetAbi = parseAbi([
  "function claim(address token)",
  "function tokenConfig(address token) view returns (uint256 claimAmount,uint256 cooldown,bool enabled)",
  "function nextClaimAt(address account,address token) view returns (uint256)",
]);

const legacyFactoryAbi = parseAbi([
  "function getPool(bytes32 id) view returns ((address baseAsset,address quoteAsset,address book,uint128 lotSize,uint128 tickSize,uint24 minTick,uint24 maxTick,bool exists) pool)",
]);

const currentFactoryAbi = parseAbi([
  "function getPool(bytes32 id) view returns ((address baseAsset,address quoteAsset,address book,uint128 lotSize,uint128 tickSize,uint24 minTick,uint24 maxTick,uint16 tradingFeeBps,uint8 baseDecimals,uint8 quoteDecimals,bool agnosticPricing,bool exists) pool)",
]);

const clobAbi = parseAbi([
  "event TradeExecuted(bytes32 indexed poolId, bytes32 indexed takerOrderId, bytes32 indexed makerOrderId, address baseAsset, address quoteAsset, uint128 price, uint128 quantity, uint256 quoteQuantity)",
  "function placeLimitOrderWithMaxBookSteps((address trader,address baseAsset,address quoteAsset,uint8 side,uint128 price,uint128 quantity,uint64 expiry,uint64 clientOrderId) order,uint32 maxBookSteps) returns (bytes32 orderId)",
  "function executeMarketOrder((address trader,address baseAsset,address quoteAsset,uint8 side,uint128 quantity,uint128 priceLimit,uint128 minFillQuantity,uint64 clientOrderId) order,uint32 maxBookSteps) returns (bytes32 orderId,uint128 filledQuantity,uint256 quoteQuantity)",
  "function cancelOrder(bytes32 orderId)",
  "function getUserOrderIds(bytes32 poolId,address trader,bytes32 cursor,uint16 limit,uint8 statusFlags) view returns (bytes32[] orderIds,bytes32 nextCursor)",
  "function getBestPrices(bytes32 poolId) view returns (bool bidExists,uint128 bidPrice,uint128 bidQuantity,bool askExists,uint128 askPrice,uint128 askQuantity)",
  "function getOrderBook(bytes32 poolId,uint16 depth) view returns ((uint128 price,uint128 quantity)[] bids,(uint128 price,uint128 quantity)[] asks)",
]);

export function decodeTradeExecutions(receipt, book, poolId) {
  const normalizedBook = getAddress(book).toLowerCase();
  const normalizedPoolId = poolId.toLowerCase();
  const trades = [];
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== normalizedBook) continue;
    try {
      const decoded = decodeEventLog({ abi: clobAbi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === "TradeExecuted" && decoded.args.poolId.toLowerCase() === normalizedPoolId) {
        trades.push(decoded.args);
      }
    } catch {
      // Other order-book events share the same emitting contract.
    }
  }
  return trades;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseRpcUrls(value) {
  return (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//.test(url));
}

export function resolveRpcUrls(urlsValue, primaryValue) {
  const configured = parseRpcUrls(urlsValue);
  if (configured.length > 0) return [...new Set(configured)];
  return [...new Set([...parseRpcUrls(primaryValue), ...DEFAULT_RPC_URLS])];
}

export function selectTakerWallet(wallets, walletNumber) {
  const index = walletNumber - 1;
  if (!Number.isInteger(walletNumber) || index < 0 || index >= wallets.length) {
    throw new Error(`MM_TAKER_WALLET must select one of the ${wallets.length} maker wallets`);
  }
  return { wallet: wallets[index], index };
}

export function planRoundWalletRoles(walletCount, round, takerEvery, takerWallet) {
  if (!Number.isInteger(walletCount) || walletCount < 1) throw new Error("walletCount must be positive");
  const roles = Array.from({ length: walletCount }, () => "maker");
  if (takerEvery === 0 || round % takerEvery !== 0) return roles;
  const takerIndex = takerWallet - 1;
  if (!Number.isInteger(takerWallet) || takerIndex < 0 || takerIndex >= walletCount) {
    throw new Error(`MM_TAKER_WALLET must select one of the ${walletCount} maker wallets`);
  }
  roles[takerIndex] = "maker+taker";
  return roles;
}

export function withThrottledReads(client, spacingMs = 100) {
  let readQueue = Promise.resolve();
  let nextReadAt = 0;
  const readContract = (request) => {
    const pending = readQueue.then(async () => {
      const waitMs = Math.max(0, nextReadAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      nextReadAt = Date.now() + spacingMs;
      return client.readContract(request);
    });
    readQueue = pending.catch(() => undefined);
    return pending;
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "readContract") return readContract;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

export function computeQuotePlan({
  bidPrice,
  askPrice,
  orderQuantity,
  levelCount,
  tickSize,
  walletCount,
  minTick,
  maxTick,
  baseAtomsPerQuantity = 1n,
  quoteDenominator = 1n,
}) {
  if (!Number.isInteger(levelCount) || levelCount < 1) throw new Error("MM_LEVELS_PER_SIDE must be positive");
  if (!Number.isInteger(walletCount) || walletCount < 1) throw new Error("walletCount must be positive");
  const levelSpan = BigInt(levelCount - 1) * tickSize;
  const deepestBid = bidPrice - levelSpan;
  const furthestAsk = askPrice + levelSpan;
  if (deepestBid < minTick || bidPrice > maxTick) {
    throw new Error("MM_BID_PRICE cannot fit the requested bid levels inside the pool bounds");
  }
  if (askPrice < minTick || furthestAsk > maxTick) {
    throw new Error("MM_ASK_PRICE cannot fit the requested ask levels inside the pool bounds");
  }
  if (bidPrice >= askPrice) throw new Error("MM_BID_PRICE must be lower than MM_ASK_PRICE");
  if (orderQuantity <= 0n) throw new Error("MM_ORDER_SIZE must be greater than zero");
  if (baseAtomsPerQuantity <= 0n || quoteDenominator <= 0n) throw new Error("Invalid market quantity scaling");
  const ordersPerWallet = Math.ceil(levelCount / walletCount);
  const quotePerOrder = (bidPrice * orderQuantity) / quoteDenominator;

  return {
    bidPrice,
    askPrice,
    deepestBid,
    furthestAsk,
    orderQuantity,
    levelCount,
    tickSize,
    ordersPerWallet,
    baseAtomsPerQuantity,
    quoteDenominator,
    baseLocked: orderQuantity * baseAtomsPerQuantity * BigInt(ordersPerWallet),
    // Conservative per-wallet bound; actual lower bid levels lock less quote.
    quoteLocked: quotePerOrder * BigInt(ordersPerWallet),
  };
}

export function requiredWalletBalances(plan, takerQuantity) {
  // Four taker-sized units provide room for in-flight alternating taker waves.
  return {
    base: plan.baseLocked + takerQuantity * plan.baseAtomsPerQuantity * 4n,
    quote: plan.quoteLocked + ((plan.askPrice * takerQuantity) / plan.quoteDenominator) * 4n,
  };
}

export function randomOrderQuantity(minimum, maximum, sample = randomInt) {
  if (minimum <= 0n || maximum < minimum) throw new Error("Invalid random order quantity range");
  if (maximum > (1n << 48n) - 2n) throw new Error("Random order quantity range is too large");
  if (minimum === maximum) return minimum;
  return BigInt(sample(Number(minimum), Number(maximum) + 1));
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function walletLabel(index) {
  return `maker ${index + 1}`;
}

function buildRuntimeConfig(pool, baseDecimals) {
  const agnosticPricing = pool.agnosticPricing;
  const fixedOrderSize = process.env.MM_ORDER_SIZE;
  const minimumOrderSize = process.env.MM_MIN_ORDER_SIZE ?? fixedOrderSize ?? "8";
  const maximumOrderSize = process.env.MM_MAX_ORDER_SIZE ?? fixedOrderSize ?? "40";
  const takerSize = process.env.MM_TAKER_SIZE ?? "1";
  const minimumOrderAtoms = parseUnits(minimumOrderSize, baseDecimals);
  const maximumOrderAtoms = parseUnits(maximumOrderSize, baseDecimals);
  const takerAtoms = parseUnits(takerSize, baseDecimals);
  if (minimumOrderAtoms <= 0n || maximumOrderAtoms < minimumOrderAtoms) {
    throw new Error("MM_MIN_ORDER_SIZE must be positive and no greater than MM_MAX_ORDER_SIZE");
  }
  if (
    !agnosticPricing &&
    (minimumOrderAtoms % pool.lotSize !== 0n ||
      maximumOrderAtoms % pool.lotSize !== 0n ||
      takerAtoms % pool.lotSize !== 0n)
  ) {
    throw new Error(`Configured order sizes must be exact multiples of lot size ${pool.lotSize}`);
  }
  const minimumOrderQuantity = agnosticPricing ? minimumOrderAtoms : minimumOrderAtoms / pool.lotSize;
  const maximumOrderQuantity = agnosticPricing ? maximumOrderAtoms : maximumOrderAtoms / pool.lotSize;
  randomOrderQuantity(minimumOrderQuantity, maximumOrderQuantity, (minimum) => minimum);

  const bidPrice = agnosticPricing
    ? parseUnits(process.env.MM_BID_PRICE ?? "0.995", 18)
    : BigInt(process.env.MM_BID_PRICE ?? "20");
  const askPrice = agnosticPricing
    ? parseUnits(process.env.MM_ASK_PRICE ?? "1.005", 18)
    : BigInt(process.env.MM_ASK_PRICE ?? "21");
  const priceStep = agnosticPricing ? parseUnits(process.env.MM_PRICE_STEP ?? "0.005", 18) : pool.tickSize;
  if (priceStep <= 0n) throw new Error("MM_PRICE_STEP must be positive");
  const quoteExponent = 18 + pool.baseDecimals - pool.quoteDecimals;
  if (agnosticPricing && quoteExponent < 0) {
    throw new Error("Unsupported base/quote decimal relationship");
  }

  const plan = computeQuotePlan({
    bidPrice,
    askPrice,
    orderQuantity: maximumOrderQuantity,
    levelCount: integerSetting("MM_LEVELS_PER_SIDE", 20, 20, 50),
    tickSize: priceStep,
    walletCount: ACCOUNT_COUNT,
    minTick: agnosticPricing ? 1n : BigInt(pool.minTick) * pool.tickSize,
    maxTick: agnosticPricing ? (1n << 128n) - 1n : BigInt(pool.maxTick) * pool.tickSize,
    baseAtomsPerQuantity: agnosticPricing ? 1n : pool.lotSize,
    quoteDenominator: agnosticPricing ? 10n ** BigInt(quoteExponent) : 1n,
  });

  if (!agnosticPricing && (plan.bidPrice % pool.tickSize !== 0n || plan.askPrice % pool.tickSize !== 0n)) {
    throw new Error(`MM_BID_PRICE and MM_ASK_PRICE must be multiples of tick size ${pool.tickSize}`);
  }

  return {
    plan,
    minimumOrderQuantity,
    maximumOrderQuantity,
    takerQuantity: agnosticPricing ? takerAtoms : takerAtoms / pool.lotSize,
    intervalMs: integerSetting("MM_INTERVAL_MS", 5_000, 250, 3_600_000),
    takerEvery: integerSetting("MM_TAKER_EVERY", 1, 0, 1_000_000),
    takerWallet: integerSetting("MM_TAKER_WALLET", ACCOUNT_COUNT, 1, ACCOUNT_COUNT),
    maxRounds: integerSetting("MM_MAX_ROUNDS", 0, 0, 1_000_000),
    maxBookSteps: integerSetting("MM_MAX_BOOK_STEPS", 64, 1, 1_024),
    txTimeoutMs: integerSetting("MM_TX_TIMEOUT_MS", 180_000, 10_000, 600_000),
    cancelOnExit: booleanSetting("MM_CANCEL_ON_EXIT", false),
  };
}

function limitOrderCall(wallet, market, side, price, quantity, maxBookSteps, clientOrderId) {
  return {
    to: market.book,
    data: encodeFunctionData({
      abi: clobAbi,
      functionName: "placeLimitOrderWithMaxBookSteps",
      args: [
        {
          trader: wallet.address,
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          side,
          price,
          quantity,
          expiry: 0n,
          clientOrderId,
        },
        maxBookSteps,
      ],
    }),
  };
}

function marketOrderCall(wallet, market, side, quantity, maxBookSteps, clientOrderId) {
  return {
    to: market.book,
    data: encodeFunctionData({
      abi: clobAbi,
      functionName: "executeMarketOrder",
      args: [
        {
          trader: wallet.address,
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          side,
          quantity,
          priceLimit: 0n,
          minFillQuantity: quantity,
          clientOrderId,
        },
        maxBookSteps,
      ],
    }),
  };
}

function cancelOrderCall(book, orderId) {
  return {
    to: book,
    data: encodeFunctionData({ abi: clobAbi, functionName: "cancelOrder", args: [orderId] }),
  };
}

function approvalCall(token, spender) {
  return {
    to: token,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, MAX_UINT256] }),
  };
}

function claimCall(faucet, token) {
  return {
    to: faucet,
    data: encodeFunctionData({ abi: faucetAbi, functionName: "claim", args: [token] }),
  };
}

async function settleParallel(label, jobs, { strict = true } = {}) {
  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter((result) => result.status === "rejected");
  for (const failure of failures)
    console.error(`${label}: ${failure.reason instanceof Error ? failure.reason.message : failure.reason}`);
  if (strict && failures.length) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${label}: ${failures.length}/${jobs.length} failed`,
    );
  }
  return settled;
}

async function assertContract(publicClient, address, label) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no contract code at ${address}`);
}

async function loadOrCreateWallets(privy, appId, poolId) {
  let state = await readJson(statePath);
  if (!state) state = { version: 1, appId, poolId, wallets: [] };
  if (state.version !== 1 || state.appId !== appId || state.poolId.toLowerCase() !== poolId.toLowerCase()) {
    throw new Error(`Saved market-maker wallet state at ${statePath} belongs to a different app or pool`);
  }

  for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
    let wallet = state.wallets[index];
    if (!wallet) {
      const keypair = await generateP256KeyPair();
      wallet = {
        index,
        id: null,
        address: null,
        publicKey: keypair.publicKey,
        authorizationPrivateKey: keypair.privateKey,
        idempotencyKey: randomUUID(),
      };
      state.wallets[index] = wallet;
      await writePrivateJson(statePath, state);
    }
    if (!wallet.id || !wallet.address) {
      const created = await privy.wallets().create({
        chain_type: "ethereum",
        display_name: `CLOB live market maker ${index + 1}`,
        external_id: `clob_live_mm_${poolId.slice(2, 10)}_${index + 1}`,
        owner: { public_key: wallet.publicKey },
        idempotency_key: wallet.idempotencyKey,
      });
      wallet.id = created.id;
      wallet.address = getAddress(created.address);
      await writePrivateJson(statePath, state);
    }
  }

  const wallets = state.wallets.slice(0, ACCOUNT_COUNT).map((wallet) => ({
    ...wallet,
    address: getAddress(wallet.address),
  }));
  console.log(`Privy wallets: ${wallets.map((wallet) => wallet.address).join(", ")}`);
  return wallets;
}

async function loadExistingWallets(appId, poolId) {
  const state = await readJson(statePath);
  if (!state) return [];
  if (state.version !== 1 || state.appId !== appId || state.poolId.toLowerCase() !== poolId.toLowerCase()) return [];
  return state.wallets
    .filter((wallet) => wallet.id && wallet.address && wallet.authorizationPrivateKey)
    .slice(0, ACCOUNT_COUNT)
    .map((wallet) => ({ ...wallet, address: getAddress(wallet.address) }));
}

async function getOpenOrderIds(publicClient, market, wallet) {
  const [orderIds] = await publicClient.readContract({
    address: market.book,
    abi: clobAbi,
    functionName: "getUserOrderIds",
    args: [market.poolId, wallet.address, ZERO_BYTES32, 64, 1],
  });
  return orderIds;
}

async function waitForPrivyTransaction(privy, transactionId, timeoutMs) {
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

function createSender({ privy, publicClient, timeoutMs, metrics }) {
  return async function sendSponsored(wallet, calls, label) {
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
    const transaction = await waitForPrivyTransaction(privy, result.transaction_id, timeoutMs);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transaction.transaction_hash,
      timeout: timeoutMs,
    });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${receipt.transactionHash}`);
    if (transaction.sponsored !== true) throw new Error(`${label} was mined but Privy did not mark it sponsored`);

    const metric = {
      at: new Date().toISOString(),
      label,
      wallet: wallet.address,
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      latencyMs: Math.round(performance.now() - startedAt),
      calls: calls.length,
      sponsored: true,
    };
    metrics.push(metric);
    console.log(`${label} · ${metric.hash} · block ${metric.blockNumber} · ${metric.latencyMs}ms`);
    return receipt;
  };
}

async function withRetries(operation, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`${label} attempt ${attempt} failed; retrying: ${error instanceof Error ? error.message : error}`);
        await sleep(1_000 * attempt);
      }
    }
  }
  throw lastError;
}

async function ensureFaucetFunding({ publicClient, sendSponsored, wallets, market, faucet, required }) {
  const now = BigInt(Math.floor(Date.now() / 1_000));
  await settleParallel(
    "faucet funding",
    wallets.map(async (wallet, index) => {
      const assets = [
        { address: market.baseAsset, required: required.base, symbol: market.baseSymbol },
        { address: market.quoteAsset, required: required.quote, symbol: market.quoteSymbol },
      ];
      const calls = [];
      for (const asset of assets) {
        const [balance, config, nextClaimAt] = await Promise.all([
          publicClient.readContract({
            address: asset.address,
            abi: tokenAbi,
            functionName: "balanceOf",
            args: [wallet.address],
          }),
          publicClient.readContract({
            address: faucet,
            abi: faucetAbi,
            functionName: "tokenConfig",
            args: [asset.address],
          }),
          publicClient.readContract({
            address: faucet,
            abi: faucetAbi,
            functionName: "nextClaimAt",
            args: [wallet.address, asset.address],
          }),
        ]);
        if (balance >= asset.required) continue;
        const [claimAmount, , enabled] = config;
        if (!enabled) throw new Error(`${asset.symbol} is not enabled on the faucet`);
        if (balance + claimAmount < asset.required) {
          throw new Error(`${walletLabel(index)} needs more ${asset.symbol} than one faucet claim provides`);
        }
        if (nextClaimAt > now) {
          throw new Error(
            `${walletLabel(index)} lacks ${asset.symbol}; faucet cooldown ends ${new Date(Number(nextClaimAt) * 1_000).toISOString()}`,
          );
        }
        calls.push(claimCall(faucet, asset.address));
      }
      if (!calls.length) return null;
      return sendSponsored(
        wallet,
        calls,
        `${walletLabel(index)} faucet ${calls.length === 2 ? "USDT + USDC" : "top-up"}`,
      );
    }),
  );
}

async function ensureApprovals({ publicClient, sendSponsored, wallets, market, required }) {
  await settleParallel(
    "token approvals",
    wallets.map(async (wallet, index) => {
      const [baseAllowance, quoteAllowance] = await Promise.all([
        publicClient.readContract({
          address: market.baseAsset,
          abi: tokenAbi,
          functionName: "allowance",
          args: [wallet.address, market.book],
        }),
        publicClient.readContract({
          address: market.quoteAsset,
          abi: tokenAbi,
          functionName: "allowance",
          args: [wallet.address, market.book],
        }),
      ]);
      const calls = [];
      if (baseAllowance < required.base) calls.push(approvalCall(market.baseAsset, market.book));
      if (quoteAllowance < required.quote) calls.push(approvalCall(market.quoteAsset, market.book));
      if (!calls.length) return null;
      return sendSponsored(wallet, calls, `${walletLabel(index)} approve book`);
    }),
  );
}

function printExecutedTrades(receipt, market, side, round, index) {
  const trades = decodeTradeExecutions(receipt, market.book, market.poolId);
  if (trades.length === 0) {
    throw new Error(`round ${round} ${walletLabel(index)} market transaction emitted no TradeExecuted event`);
  }
  const sideLabel = side === 0 ? "buy" : "sell";
  for (const trade of trades) {
    console.log(
      `round ${round} ${walletLabel(index)} TradeExecuted · ${sideLabel} ` +
        `${formatUnits(baseQuantityAtoms(trade.quantity, market), market.baseDecimals)} ${market.baseSymbol} ` +
        `@ ${humanPrice(trade.price, market)} ${market.quoteSymbol} · ` +
        `${formatUnits(trade.quoteQuantity, market.quoteDecimals)} ${market.quoteSymbol}`,
    );
  }
}

async function makerRequote({
  publicClient,
  sendSponsored,
  wallets,
  wallet,
  index,
  market,
  runtime,
  nextClientOrderId,
  round,
  includeMarketTrade = false,
}) {
  const marketSide = round % 2 === 1 ? 0 : 1;
  const receipt = await withRetries(
    async () => {
      const openOrderIds = await getOpenOrderIds(publicClient, market, wallet);
      const calls = openOrderIds.map((orderId) => cancelOrderCall(market.book, orderId));
      for (let order = 0; order < runtime.plan.ordersPerWallet; order += 1) {
        const level = index + order * wallets.length;
        if (level >= runtime.plan.levelCount) continue;
        const priceOffset = BigInt(level) * runtime.plan.tickSize;
        const bidQuantity = randomOrderQuantity(runtime.minimumOrderQuantity, runtime.maximumOrderQuantity);
        const askQuantity = randomOrderQuantity(runtime.minimumOrderQuantity, runtime.maximumOrderQuantity);
        calls.push(
          limitOrderCall(
            wallet,
            market,
            0,
            runtime.plan.bidPrice - priceOffset,
            bidQuantity,
            runtime.maxBookSteps,
            nextClientOrderId(),
          ),
          limitOrderCall(
            wallet,
            market,
            1,
            runtime.plan.askPrice + priceOffset,
            askQuantity,
            runtime.maxBookSteps,
            nextClientOrderId(),
          ),
        );
      }
      let action = "cancel/requote";
      if (includeMarketTrade) {
        const sideLabel = marketSide === 0 ? "buy" : "sell";
        calls.push(
          marketOrderCall(wallet, market, marketSide, runtime.takerQuantity, runtime.maxBookSteps, nextClientOrderId()),
        );
        action += ` + market ${sideLabel}`;
      }
      return sendSponsored(wallet, calls, `round ${round} ${walletLabel(index)} ${action}`);
    },
    `round ${round} ${walletLabel(index)}`,
  );
  if (includeMarketTrade) printExecutedTrades(receipt, market, marketSide, round, index);
  return receipt;
}

async function marketTrade({ sendSponsored, wallet, index, market, runtime, nextClientOrderId, round }) {
  const side = round % 2 === 1 ? 0 : 1;
  const sideLabel = side === 0 ? "buy" : "sell";
  const receipt = await withRetries(
    () =>
      sendSponsored(
        wallet,
        [marketOrderCall(wallet, market, side, runtime.takerQuantity, runtime.maxBookSteps, nextClientOrderId())],
        `round ${round} ${walletLabel(index)} market ${sideLabel}`,
      ),
    `round ${round} ${walletLabel(index)} market ${sideLabel}`,
  );
  printExecutedTrades(receipt, market, side, round, index);
  return receipt;
}

async function takerWave({ sendSponsored, wallets, market, runtime, nextClientOrderId, round }) {
  const { wallet, index } = selectTakerWallet(wallets, runtime.takerWallet);
  await marketTrade({ sendSponsored, wallet, index, market, runtime, nextClientOrderId, round });
}

async function parallelTradingWave({
  publicClient,
  sendSponsored,
  wallets,
  market,
  runtime,
  nextClientOrderId,
  round,
}) {
  const roles = planRoundWalletRoles(wallets.length, round, runtime.takerEvery, runtime.takerWallet);
  await settleParallel(
    `parallel trading wave ${round}`,
    wallets.map((wallet, index) =>
      makerRequote({
        publicClient,
        sendSponsored,
        wallets,
        wallet,
        index,
        market,
        runtime,
        nextClientOrderId,
        round,
        includeMarketTrade: roles[index] === "maker+taker",
      }),
    ),
  );
}

async function cancelAll({ publicClient, sendSponsored, wallets, market }) {
  await settleParallel(
    "cancel open orders",
    wallets.map(async (wallet, index) => {
      const orderIds = await getOpenOrderIds(publicClient, market, wallet);
      if (!orderIds.length) return null;
      return sendSponsored(
        wallet,
        orderIds.map((orderId) => cancelOrderCall(market.book, orderId)),
        `${walletLabel(index)} cancel ${orderIds.length} orders`,
      );
    }),
  );
}

function humanPrice(price, market) {
  if (market.agnosticPricing) return formatUnits(price, 18);
  const numerator = Number(price) * 10 ** market.baseDecimals;
  const denominator = Number(market.lotSize) * 10 ** market.quoteDecimals;
  return (numerator / denominator).toFixed(6);
}

function baseQuantityAtoms(quantity, market) {
  return market.agnosticPricing ? quantity : quantity * market.lotSize;
}

async function printBook(publicClient, market, round) {
  const [bestPrices, orderBook] = await Promise.all([
    publicClient.readContract({
      address: market.book,
      abi: clobAbi,
      functionName: "getBestPrices",
      args: [market.poolId],
    }),
    publicClient.readContract({
      address: market.book,
      abi: clobAbi,
      functionName: "getOrderBook",
      args: [market.poolId, 50],
    }),
  ]);
  const [bidExists, bidPrice, bidQuantity, askExists, askPrice, askQuantity] = bestPrices;
  const [bids, asks] = orderBook;
  const bid = bidExists
    ? `${humanPrice(bidPrice, market)} × ${formatUnits(baseQuantityAtoms(bidQuantity, market), market.baseDecimals)}`
    : "empty";
  const ask = askExists
    ? `${humanPrice(askPrice, market)} × ${formatUnits(baseQuantityAtoms(askQuantity, market), market.baseDecimals)}`
    : "empty";
  console.log(
    `round ${round} book · ${bids.length} bid levels / ${asks.length} ask levels · ` +
      `best bid ${bid} ${market.quoteSymbol}/${market.baseSymbol} · best ask ${ask}`,
  );
  return { bidExists, bidPrice, bidQuantity, askExists, askPrice, askQuantity, bids, asks };
}

async function loadMarket(publicClient, factory, poolId) {
  const request = encodeFunctionData({ abi: currentFactoryAbi, functionName: "getPool", args: [poolId] });
  const response = await publicClient.call({ to: factory, data: request });
  if (!response.data) throw new Error(`Pool ${poolId} returned no metadata`);
  let pool;
  try {
    pool = decodeFunctionResult({ abi: currentFactoryAbi, functionName: "getPool", data: response.data });
  } catch {
    const legacy = decodeFunctionResult({ abi: legacyFactoryAbi, functionName: "getPool", data: response.data });
    pool = {
      ...legacy,
      tradingFeeBps: 0,
      baseDecimals: 0,
      quoteDecimals: 0,
      agnosticPricing: false,
    };
  }
  if (!pool.exists) throw new Error(`Pool ${poolId} does not exist at factory ${factory}`);
  const [baseSymbol, quoteSymbol, baseDecimals, quoteDecimals] = await Promise.all([
    publicClient.readContract({ address: pool.baseAsset, abi: tokenAbi, functionName: "symbol" }),
    publicClient.readContract({ address: pool.quoteAsset, abi: tokenAbi, functionName: "symbol" }),
    publicClient.readContract({ address: pool.baseAsset, abi: tokenAbi, functionName: "decimals" }),
    publicClient.readContract({ address: pool.quoteAsset, abi: tokenAbi, functionName: "decimals" }),
  ]);
  return {
    ...pool,
    poolId,
    book: getAddress(pool.book),
    baseAsset: getAddress(pool.baseAsset),
    quoteAsset: getAddress(pool.quoteAsset),
    baseSymbol,
    quoteSymbol,
    baseDecimals,
    quoteDecimals,
  };
}

export async function main() {
  const appId = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Set NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) and PRIVY_APP_SECRET in apps/web/.env.local");
  }

  const rpcUrls = resolveRpcUrls(process.env.NEXT_PUBLIC_MONAD_RPC_URLS, process.env.NEXT_PUBLIC_MONAD_RPC_URL);
  const factory = getAddress(DEFAULT_FACTORY);
  const faucet = getAddress(DEFAULT_FAUCET);
  const poolId = process.env.MM_POOL_ID ?? DEFAULT_POOL_ID;
  const dryRun = process.argv.includes("--dry-run");
  const provisionOnly = process.argv.includes("--provision-only");
  const cleanupOnly = process.argv.includes("--cleanup");
  const tradeOnly = process.argv.includes("--trade-only");
  const tradeOnlySell = process.argv.includes("--sell");
  const once = process.argv.includes("--once");

  const chain = {
    id: CHAIN_ID,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  };
  const rpcTransports = rpcUrls.map((url) => http(url, { retryCount: 0, timeout: 4_000 }));
  const publicClient = withThrottledReads(
    createPublicClient({
      chain,
      transport: rpcTransports.length === 1 ? rpcTransports[0] : fallback(rpcTransports, { retryCount: 0 }),
    }),
  );
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Refusing to run on chain ${chainId}; expected Monad Testnet ${CHAIN_ID}`);
  await Promise.all([
    assertContract(publicClient, factory, "SpotCLOBFactory"),
    assertContract(publicClient, faucet, "TokenFaucet"),
  ]);

  const market = await loadMarket(publicClient, factory, poolId);
  await Promise.all([
    assertContract(publicClient, market.book, "SpotCLOB"),
    assertContract(publicClient, market.baseAsset, market.baseSymbol),
    assertContract(publicClient, market.quoteAsset, market.quoteSymbol),
  ]);
  if (market.baseAsset !== getAddress(DEFAULT_USDT) || market.quoteAsset !== getAddress(DEFAULT_USDC)) {
    console.warn(`Pool is ${market.baseSymbol}/${market.quoteSymbol}, not the default USDT/USDC deployment`);
  }

  const runtime = buildRuntimeConfig(market, market.baseDecimals);
  const required = requiredWalletBalances(runtime.plan, runtime.takerQuantity);
  console.log(`RPC failover · ${rpcUrls.join(" -> ")}`);
  console.log(
    `Live ${market.baseSymbol}/${market.quoteSymbol} maker · pool ${poolId} · book ${market.book} · ` +
      `${ACCOUNT_COUNT} parallel Privy wallets · bid ${humanPrice(runtime.plan.bidPrice, market)} · ` +
      `ask ${humanPrice(runtime.plan.askPrice, market)} · ${runtime.plan.levelCount} levels/side · ` +
      `${formatUnits(baseQuantityAtoms(runtime.minimumOrderQuantity, market), market.baseDecimals)}–` +
      `${formatUnits(baseQuantityAtoms(runtime.maximumOrderQuantity, market), market.baseDecimals)} ${market.baseSymbol}/order`,
  );

  const privy = new PrivyClient({ appId, appSecret });
  if (dryRun) {
    const wallets = await loadExistingWallets(appId, poolId);
    console.log(
      `Preflight passed. Saved Privy market-maker wallets: ${wallets.length}/${ACCOUNT_COUNT}. No transactions submitted.`,
    );
    await printBook(publicClient, market, 0);
    return;
  }

  const wallets = await loadOrCreateWallets(privy, appId, poolId);
  const metrics = [];
  const sendSponsored = createSender({ privy, publicClient, timeoutMs: runtime.txTimeoutMs, metrics });
  let clientOrderId = BigInt(Date.now()) * 100_000n;
  const nextClientOrderId = () => {
    clientOrderId += 1n;
    return clientOrderId;
  };

  if (cleanupOnly) {
    await cancelAll({ publicClient, sendSponsored, wallets, market });
    await printBook(publicClient, market, 0);
    return;
  }

  await ensureFaucetFunding({ publicClient, sendSponsored, wallets, market, faucet, required });
  await ensureApprovals({ publicClient, sendSponsored, wallets, market, required });
  if (provisionOnly) {
    console.log("Provisioning complete: five Privy wallets funded from both faucets and approved for the book.");
    return;
  }
  if (tradeOnly) {
    const round = tradeOnlySell ? 2 : 1;
    await takerWave({
      sendSponsored,
      wallets,
      market,
      runtime,
      nextClientOrderId,
      round,
    });
    await printBook(publicClient, market, round);
    return;
  }

  let stopRequested = false;
  const requestStop = () => {
    if (!stopRequested) console.log("Stop requested; finishing the current wave.");
    stopRequested = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  const startedAt = new Date().toISOString();
  const effectiveMaxRounds = once ? 1 : runtime.maxRounds;
  let completedRounds = 0;
  let consecutiveFailures = 0;
  while (!stopRequested && (effectiveMaxRounds === 0 || completedRounds < effectiveMaxRounds)) {
    const round = completedRounds + 1;
    try {
      await parallelTradingWave({ publicClient, sendSponsored, wallets, market, runtime, nextClientOrderId, round });
      await printBook(publicClient, market, round);
      completedRounds = round;
      consecutiveFailures = 0;
      await writePrivateJson(reportPath, {
        startedAt,
        updatedAt: new Date().toISOString(),
        poolId,
        book: market.book,
        completedRounds,
        wallets: wallets.map(({ address }) => address),
        transactionCount: metrics.length,
        metrics: metrics.slice(-100),
      });
    } catch (error) {
      consecutiveFailures += 1;
      console.error(
        `round ${round} failed (${consecutiveFailures} consecutive): ${error instanceof Error ? error.message : error}`,
      );
      if (consecutiveFailures >= 5) throw new Error("Five consecutive market-making rounds failed", { cause: error });
    }
    if (!stopRequested && (effectiveMaxRounds === 0 || completedRounds < effectiveMaxRounds))
      await sleep(runtime.intervalMs);
  }

  if (runtime.cancelOnExit) await cancelAll({ publicClient, sendSponsored, wallets, market });
  console.log(`Stopped after ${completedRounds} rounds and ${metrics.length} sponsored transactions.`);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  await main();
  process.exit(0);
}
