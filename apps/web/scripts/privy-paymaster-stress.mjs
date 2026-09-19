import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateP256KeyPair, PrivyClient } from "@privy-io/node";
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
const ACCOUNT_COUNT = 5;
const MARKET_COUNT = 2;
const contracts = clobContractsByChainId[CHAIN_ID];
const DEFAULT_FACTORY = contracts.factoryAddress;
const DEFAULT_TOKEN_FACTORY = contracts.tokenFactoryAddress;
const DEFAULT_FAUCET = contracts.faucetAddress;
const DEFAULT_USDC = contracts.faucetTokens.find((token) => token.symbol === "USDC")?.address;

if (!DEFAULT_FACTORY || !DEFAULT_TOKEN_FACTORY || !DEFAULT_FAUCET || !DEFAULT_USDC) {
  throw new Error(`Incomplete contract configuration for chain ${CHAIN_ID}`);
}
const MAX_UINT256 = (1n << 256n) - 1n;
const BASE_FUNDING = 2_000n * 10n ** 18n;
const MIN_BASE_BALANCE = 500n * 10n ** 18n;
const MIN_QUOTE_BALANCE = 100n * 10n ** 6n;
const TICK_SIZE = 1_000n;
const MIN_TICK = 1;
const MAX_TICK = 100_000;

const rpcUrl = process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const factoryAddress = getAddress(DEFAULT_FACTORY);
const tokenFactoryAddress = getAddress(DEFAULT_TOKEN_FACTORY);
const faucetAddress = getAddress(DEFAULT_FAUCET);
const quoteAddress = getAddress(DEFAULT_USDC);
const appId = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
const rounds = Math.min(100, Math.max(1, Number.parseInt(process.env.STRESS_ROUNDS ?? "5", 10)));
const dryRun = process.argv.includes("--dry-run");
const provisionOnly = process.argv.includes("--provision-only");
const statePath = fileURLToPath(new URL("../.env.privy-stress-state.json", import.meta.url));
const reportPath = fileURLToPath(new URL("../.env.privy-stress-report.json", import.meta.url));

if (!appId || !appSecret) {
  throw new Error(
    "Set NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) and PRIVY_APP_SECRET before running the Privy stress test",
  );
}

const monadTestnet = {
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const privy = new PrivyClient({ appId, appSecret });
const metrics = [];
let clientOrderId = BigInt(Date.now()) * 100_000n;

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
  "function pairId(address baseAsset, address quoteAsset) pure returns (bytes32)",
  "function createPair(address baseAsset, address quoteAsset, uint128 tickSize, uint24 minTick, uint24 maxTick) returns (bytes32 id, address book)",
  "function getPool(bytes32 id) view returns ((address baseAsset, address quoteAsset, address book, uint128 lotSize, uint128 tickSize, uint24 minTick, uint24 maxTick, bool exists) pool)",
]);

const clobAbi = [
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let rpcReadQueue = Promise.resolve();
let nextRpcReadAt = 0;

function readContract(request) {
  const pending = rpcReadQueue.then(async () => {
    const waitMs = Math.max(0, nextRpcReadAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextRpcReadAt = Date.now() + 100;
    return publicClient.readContract(request);
  });
  rpcReadQueue = pending.catch(() => undefined);
  return pending;
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

async function loadState() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.version !== 1 || state.appId !== appId) {
      throw new Error(`Privy stress state at ${statePath} belongs to another app or schema version`);
    }
    state.wallets ??= [];
    state.tokens ??= [];
    return state;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, appId, wallets: [], tokens: [] };
  }
}

async function saveState(state) {
  await writeFile(statePath, `${stringify(state)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
}

async function assertContract(address, label) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${label} has no contract code at ${address}`);
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
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for Privy transaction ${transactionId}`);
}

async function sendSponsored(wallet, calls, label) {
  const startedAt = performance.now();
  let transactionId;
  try {
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
    transactionId = result.transaction_id;
    const transaction = await waitForPrivyTransaction(transactionId);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transaction.transaction_hash,
      timeout: 180_000,
    });
    if (receipt.status !== "success") throw new Error(`Transaction ${receipt.transactionHash} reverted`);
    const metric = {
      label,
      wallet: wallet.address,
      transactionId,
      hash: receipt.transactionHash,
      sponsored: transaction.sponsored === true,
      latencyMs: Math.round(performance.now() - startedAt),
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
      calls: calls.length,
    };
    metrics.push(metric);
    console.log(`${label} · ${metric.hash} · ${metric.latencyMs}ms · sponsored=${metric.sponsored}`);
    return { metric, receipt };
  } catch (error) {
    metrics.push({
      label,
      wallet: wallet.address,
      transactionId,
      sponsored: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runParallel(label, jobs) {
  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    const messages = failures.map((failure) =>
      failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
    );
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${label}: ${messages.join("; ")}`,
    );
  }
  return settled.map((result) => result.value);
}

async function provisionWallets(state) {
  for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
    let saved = state.wallets[index];
    if (!saved) {
      const keypair = await generateP256KeyPair();
      saved = {
        index,
        id: null,
        address: null,
        publicKey: keypair.publicKey,
        authorizationPrivateKey: keypair.privateKey,
        idempotencyKey: randomUUID(),
      };
      state.wallets[index] = saved;
      await saveState(state);
    }
    if (!saved.id || !saved.address) {
      const created = await privy.wallets().create({
        chain_type: "ethereum",
        display_name: `CLOB stress trader ${index + 1}`,
        external_id: `clob_stress_trader_${index + 1}`,
        owner: { public_key: saved.publicKey },
        idempotency_key: saved.idempotencyKey,
      });
      saved.id = created.id;
      saved.address = getAddress(created.address);
      await saveState(state);
    }
  }
  console.log(`Privy wallets: ${state.wallets.map((wallet) => wallet.address).join(", ")}`);
  return state.wallets;
}

async function provisionTokens(state, ownerWallet) {
  const definitions = [
    { name: "CLOB Stress Alpha", symbol: "CSTA" },
    { name: "CLOB Stress Beta", symbol: "CSTB" },
  ];
  for (let index = 0; index < MARKET_COUNT; index += 1) {
    const existing = state.tokens[index];
    if (existing?.address) {
      const code = await publicClient.getCode({ address: existing.address });
      if (code && code !== "0x") continue;
    }
    const definition = definitions[index];
    const data = encodeFunctionData({
      abi: tokenFactoryAbi,
      functionName: "createToken",
      args: [definition.name, definition.symbol, 18, 1_000_000n * 10n ** 18n],
    });
    const { receipt } = await sendSponsored(
      ownerWallet,
      [{ to: tokenFactoryAddress, data }],
      `create ${definition.symbol}`,
    );
    let tokenAddress;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: tokenFactoryAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "TokenCreated") tokenAddress = getAddress(decoded.args.token);
      } catch {
        // Ignore unrelated logs in the receipt.
      }
    }
    if (!tokenAddress) throw new Error(`Unable to find TokenCreated for ${definition.symbol}`);
    state.tokens[index] = { ...definition, address: tokenAddress };
    await saveState(state);
  }
  return state.tokens;
}

async function provisionMarkets(tokens, ownerWallet) {
  const markets = [];
  for (const token of tokens) {
    const poolId = keccak256(
      encodeAbiParameters(parseAbiParameters("address, address"), [token.address, quoteAddress]),
    );
    let pool = await readContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "getPool",
      args: [poolId],
    });
    if (!pool.exists) {
      const data = encodeFunctionData({
        abi: factoryAbi,
        functionName: "createPair",
        args: [token.address, quoteAddress, TICK_SIZE, MIN_TICK, MAX_TICK],
      });
      await sendSponsored(ownerWallet, [{ to: factoryAddress, data }], `create ${token.symbol}/USDC market`);
      pool = await readContract({
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "getPool",
        args: [poolId],
      });
    }
    if (!pool.exists) throw new Error(`Factory did not register ${token.symbol}/USDC`);
    markets.push({
      ...token,
      poolId,
      book: getAddress(pool.book),
      centerPrice: BigInt(markets.length + 1) * 1_000_000n,
    });
  }
  console.log(`Markets: ${markets.map((market) => `${market.symbol}/USDC ${market.book}`).join(", ")}`);
  return markets;
}

async function fundWallets(wallets, tokens) {
  const quoteBalances = await Promise.all(
    wallets.map((wallet) =>
      readContract({
        address: quoteAddress,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [wallet.address],
      }),
    ),
  );
  const claims = wallets.flatMap((wallet, index) =>
    quoteBalances[index] < MIN_QUOTE_BALANCE
      ? [
          sendSponsored(
            wallet,
            [
              {
                to: faucetAddress,
                data: encodeFunctionData({ abi: faucetAbi, functionName: "claim", args: [quoteAddress] }),
              },
            ],
            `fund trader ${index + 1} with USDC`,
          ),
        ]
      : [],
  );
  if (claims.length > 0) await runParallel("USDC faucet funding", claims);

  for (const token of tokens) {
    const owner = await readContract({ address: token.address, abi: tokenAbi, functionName: "owner" });
    if (owner.toLowerCase() !== wallets[0].address.toLowerCase()) {
      throw new Error(`${token.symbol} is not owned by stress trader 1`);
    }
    const balances = await Promise.all(
      wallets.map((wallet) =>
        readContract({
          address: token.address,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [wallet.address],
        }),
      ),
    );
    const calls = wallets.flatMap((wallet, index) =>
      balances[index] < MIN_BASE_BALANCE
        ? [
            {
              to: token.address,
              data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [wallet.address, BASE_FUNDING] }),
            },
          ]
        : [],
    );
    if (calls.length > 0) await sendSponsored(wallets[0], calls, `fund all traders with ${token.symbol}`);
  }
}

async function approveMarkets(wallets, markets) {
  await runParallel(
    "market approvals",
    wallets.map(async (wallet, walletIndex) => {
      const calls = [];
      for (const market of markets) {
        for (const asset of [market.address, quoteAddress]) {
          const allowance = await readContract({
            address: asset,
            abi: tokenAbi,
            functionName: "allowance",
            args: [wallet.address, market.book],
          });
          if (allowance < MIN_BASE_BALANCE) {
            calls.push({
              to: asset,
              data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [market.book, MAX_UINT256] }),
            });
          }
        }
      }
      if (calls.length === 0) return null;
      return sendSponsored(wallet, calls, `approve trader ${walletIndex + 1} on both markets`);
    }),
  );
}

function nextClientOrderId() {
  clientOrderId += 1n;
  return clientOrderId;
}

function limitOrderCall(wallet, market, side, price) {
  return {
    to: market.book,
    data: encodeFunctionData({
      abi: clobAbi,
      functionName: "placeLimitOrderWithMaxBookSteps",
      args: [
        {
          trader: wallet.address,
          baseAsset: market.address,
          quoteAsset: quoteAddress,
          side,
          price,
          quantity: 1n,
          expiry: 0n,
          clientOrderId: nextClientOrderId(),
        },
        64,
      ],
    }),
  };
}

function marketOrderCall(wallet, market, side) {
  return {
    to: market.book,
    data: encodeFunctionData({
      abi: clobAbi,
      functionName: "executeMarketOrder",
      args: [
        {
          trader: wallet.address,
          baseAsset: market.address,
          quoteAsset: quoteAddress,
          side,
          quantity: 1n,
          priceLimit: 0n,
          minFillQuantity: 1n,
          clientOrderId: nextClientOrderId(),
        },
        64,
      ],
    }),
  };
}

async function runStress(wallets, markets) {
  const nativeBefore = await Promise.all(wallets.map((wallet) => publicClient.getBalance({ address: wallet.address })));
  const firstMetric = metrics.length;
  const startedAt = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    await runParallel(
      `round ${round + 1} maker wave`,
      wallets.map((wallet, walletIndex) => {
        const calls = markets.map((market, marketIndex) => {
          const side = (walletIndex + marketIndex) % 2 === 0 ? 1 : 0;
          const offset = 20_000n + BigInt(walletIndex + 1) * TICK_SIZE;
          const price = side === 1 ? market.centerPrice + offset : market.centerPrice - offset;
          return limitOrderCall(wallet, market, side, price);
        });
        return sendSponsored(wallet, calls, `round ${round + 1} maker trader ${walletIndex + 1}`);
      }),
    );

    await runParallel(
      `round ${round + 1} taker wave`,
      wallets.map((wallet, walletIndex) => {
        const calls = markets.map((market, marketIndex) => {
          const makerSide = (walletIndex + marketIndex) % 2 === 0 ? 1 : 0;
          return marketOrderCall(wallet, market, makerSide === 1 ? 0 : 1);
        });
        return sendSponsored(wallet, calls, `round ${round + 1} taker trader ${walletIndex + 1}`);
      }),
    );
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const nativeAfter = await Promise.all(wallets.map((wallet) => publicClient.getBalance({ address: wallet.address })));
  const stressMetrics = metrics.slice(firstMetric);
  const uniqueChainMetrics = [
    ...new Map(stressMetrics.filter((metric) => metric.hash).map((metric) => [metric.hash, metric])).values(),
  ];
  const latencies = stressMetrics.map((metric) => metric.latencyMs).sort((left, right) => left - right);
  const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)] ?? 0;
  const books = await Promise.all(
    markets.map(async (market) => ({
      symbol: market.symbol,
      bestPrices: await readContract({
        address: market.book,
        abi: clobAbi,
        functionName: "getBestPrices",
        args: [market.poolId],
      }),
    })),
  );
  return {
    rounds,
    accounts: wallets.map((wallet, index) => ({
      index: index + 1,
      address: wallet.address,
      nativeBalanceBefore: nativeBefore[index],
      nativeBalanceAfter: nativeAfter[index],
      nativeGasPaid: nativeBefore[index] - nativeAfter[index],
    })),
    markets: markets.map(({ symbol, address, poolId, book }) => ({
      symbol,
      baseToken: address,
      quoteToken: quoteAddress,
      poolId,
      book,
    })),
    durationMs,
    sponsoredTransactions: stressMetrics.filter((metric) => metric.sponsored).length,
    totalTransactions: stressMetrics.length,
    uniqueChainTransactions: uniqueChainMetrics.length,
    orderCalls: stressMetrics.reduce((total, metric) => total + (metric.calls ?? 0), 0),
    transactionsPerSecond: stressMetrics.length / (durationMs / 1_000),
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    gasUsed: uniqueChainMetrics.reduce((total, metric) => total + (metric.gasUsed ?? 0n), 0n),
    books,
  };
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Refusing to run on chain ${chainId}; expected Monad Testnet ${CHAIN_ID}`);
  await Promise.all([
    assertContract(factoryAddress, "SpotCLOBFactory"),
    assertContract(tokenFactoryAddress, "ERC20TokenFactory"),
    assertContract(faucetAddress, "TokenFaucet"),
    assertContract(quoteAddress, "USDC"),
  ]);
  const state = await loadState();
  if (dryRun) {
    console.log(
      `Preflight passed on Monad Testnet. Saved Privy wallets: ${state.wallets.filter((wallet) => wallet.id).length}/${ACCOUNT_COUNT}`,
    );
    return;
  }

  const wallets = await provisionWallets(state);
  const tokens = await provisionTokens(state, wallets[0]);
  const markets = await provisionMarkets(tokens, wallets[0]);
  await fundWallets(wallets, tokens);
  await approveMarkets(wallets, markets);
  if (provisionOnly) {
    console.log("Provisioning complete; no stress rounds were submitted.");
    return;
  }

  const summary = await runStress(wallets, markets);
  const report = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    factory: factoryAddress,
    summary,
    transactions: metrics.map(({ transactionId: _, ...metric }) => metric),
  };
  await writeFile(reportPath, `${stringify(report)}\n`, { mode: 0o600 });
  await chmod(reportPath, 0o600);

  console.log(
    `Complete: ${summary.totalTransactions}/${summary.totalTransactions} Privy submissions (${summary.uniqueChainTransactions} chain transactions), ${summary.orderCalls} order calls, ${summary.transactionsPerSecond.toFixed(2)} submissions/s`,
  );
  console.log(
    `Latency: p50 ${summary.p50LatencyMs}ms, p95 ${summary.p95LatencyMs}ms; native gas paid by traders: ${summary.accounts.reduce((total, account) => total + account.nativeGasPaid, 0n)}`,
  );
  console.log(`Report: ${reportPath}`);
  if (summary.sponsoredTransactions !== summary.totalTransactions) {
    throw new Error(
      `Privy reported only ${summary.sponsoredTransactions}/${summary.totalTransactions} stress transactions as sponsored`,
    );
  }
  if (summary.accounts.some((account) => account.nativeGasPaid !== 0n)) {
    throw new Error("At least one trader paid native gas during the sponsored stress run");
  }
}

await main();
process.exit(0);
