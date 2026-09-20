import assert from "node:assert/strict";
import test from "node:test";

import {
  computeQuotePlan,
  decodeTradeExecutions,
  planRoundWalletRoles,
  randomOrderQuantity,
  requiredWalletBalances,
  resolveRpcUrls,
  selectTakerWallet,
  withThrottledReads,
} from "./live-privy-market-maker.mjs";

test("decodes an executed market fill from a sponsored batch receipt", () => {
  const trades = decodeTradeExecutions(
    {
      logs: [
        {
          address: "0x3d4e75ba9f53908345ce12951ee697b17a455e30",
          topics: [
            "0x905b132bf4071004d0ff2e27598215eae4c5308a1553a3896ae2c25c05800a3f",
            "0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c",
            "0x0000000000000000000000000000000000000000000000000000000000008981",
            "0x000000000000000000000000000000000000000000000000000000000000893e",
          ],
          data:
            "0x000000000000000000000000ef271f6433e05757a94e28873911af92f0d0b9f3" +
            "000000000000000000000000a3bcafb554fe87109b92b3655c7cf36ba5c46af3" +
            "0000000000000000000000000000000000000000000000000df27a2cdf448000" +
            "00000000000000000000000000000000000000000000000000000000000f4240" +
            "00000000000000000000000000000000000000000000000000000000000f55c8",
        },
      ],
    },
    "0x3d4E75bA9f53908345ce12951EE697B17a455E30",
    "0x453ab8f8cee39a86e7ca582a11552cc53a761a4e2286929255ad148342d1909c",
  );

  assert.equal(trades.length, 1);
  assert.equal(trades[0].price, 1_005_000_000_000_000_000n);
  assert.equal(trades[0].quantity, 1_000_000n);
  assert.equal(trades[0].quoteQuantity, 1_005_000n);
});

test("builds a deduplicated Monad RPC failover list", () => {
  assert.deepEqual(resolveRpcUrls(undefined, "https://primary.example"), [
    "https://primary.example",
    "https://testnet-rpc.monad.xyz",
    "https://rpc.ankr.com/monad_testnet",
    "https://rpc-testnet.monadinfra.com",
    "https://monad-testnet.drpc.org",
    "https://lb.routeme.sh/rpc/evm/10143",
    "https://monad-testnet.gateway.tatum.io",
    "https://monad-testnet-rpc.huginn.tech",
  ]);
  assert.deepEqual(resolveRpcUrls("https://one.example, https://two.example,https://one.example", undefined), [
    "https://one.example",
    "https://two.example",
  ]);
});

test("selects exactly one configured wallet for taker trades", () => {
  const wallets = Array.from({ length: 5 }, (_, index) => ({ id: `wallet-${index + 1}` }));

  assert.deepEqual(selectTakerWallet(wallets, 5), { wallet: wallets[4], index: 4 });
  assert.throws(() => selectTakerWallet(wallets, 6), /MM_TAKER_WALLET/);
});

test("plans five maker requotes with one batched market trade in the same round", () => {
  assert.deepEqual(planRoundWalletRoles(5, 1, 1, 5), ["maker", "maker", "maker", "maker", "maker+taker"]);
  assert.deepEqual(planRoundWalletRoles(5, 2, 0, 5), ["maker", "maker", "maker", "maker", "maker"]);
});

test("computes maker escrow and taker headroom in token atoms", () => {
  const plan = computeQuotePlan({
    bidPrice: 2n,
    askPrice: 3n,
    orderQuantity: 25_000_000n,
    levelCount: 2,
    tickSize: 1n,
    walletCount: 1,
    minTick: 1n,
    maxTick: 16_777_215n,
  });

  assert.equal(plan.baseLocked, 50_000_000n);
  assert.equal(plan.quoteLocked, 100_000_000n);
  assert.deepEqual(requiredWalletBalances(plan, 1_000_000n), {
    base: 54_000_000n,
    quote: 112_000_000n,
  });
});

test("rejects crossed and out-of-range quote plans", () => {
  const valid = {
    bidPrice: 1n,
    askPrice: 2n,
    orderQuantity: 1n,
    levelCount: 1,
    tickSize: 1n,
    walletCount: 1,
    minTick: 1n,
    maxTick: 10n,
  };

  assert.throws(() => computeQuotePlan({ ...valid, bidPrice: 2n }), /lower than/);
  assert.throws(() => computeQuotePlan({ ...valid, askPrice: 11n }), /pool bounds/);
  assert.throws(() => computeQuotePlan({ ...valid, orderQuantity: 0n }), /greater than zero/);
});

test("distributes twenty distinct levels across five wallets", () => {
  const plan = computeQuotePlan({
    bidPrice: 20n,
    askPrice: 21n,
    orderQuantity: 25_000_000n,
    levelCount: 20,
    tickSize: 1n,
    walletCount: 5,
    minTick: 1n,
    maxTick: 16_777_215n,
  });

  assert.equal(plan.deepestBid, 1n);
  assert.equal(plan.furthestAsk, 40n);
  assert.equal(plan.ordersPerWallet, 4);
  assert.equal(plan.baseLocked, 100_000_000n);
  assert.equal(plan.quoteLocked, 2_000_000_000n);
});

test("covers the stable-pair range from 0.90 through 1.10", () => {
  const plan = computeQuotePlan({
    bidPrice: 995_000_000_000_000_000n,
    askPrice: 1_005_000_000_000_000_000n,
    orderQuantity: 40_000_000n,
    levelCount: 20,
    tickSize: 5_000_000_000_000_000n,
    walletCount: 5,
    minTick: 1n,
    maxTick: (1n << 128n) - 1n,
    quoteDenominator: 1_000_000_000_000_000_000n,
  });

  assert.equal(plan.deepestBid, 900_000_000_000_000_000n);
  assert.equal(plan.furthestAsk, 1_100_000_000_000_000_000n);
  assert.equal(plan.baseLocked, 160_000_000n);
  assert.equal(plan.quoteLocked, 159_200_000n);
  assert.deepEqual(requiredWalletBalances(plan, 1_000_000n), {
    base: 164_000_000n,
    quote: 163_220_000n,
  });
});

test("generates bounded independent order quantities", () => {
  assert.equal(
    randomOrderQuantity(8_000_000n, 40_000_000n, (minimum) => minimum),
    8_000_000n,
  );
  assert.equal(
    randomOrderQuantity(8_000_000n, 40_000_000n, (_, maximum) => maximum - 1),
    40_000_000n,
  );
  assert.equal(randomOrderQuantity(25_000_000n, 25_000_000n), 25_000_000n);
  assert.throws(() => randomOrderQuantity(10n, 9n), /Invalid/);
});

test("serializes RPC contract reads while preserving other client methods", async () => {
  let active = 0;
  let peak = 0;
  const client = {
    readContract: async ({ value }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value;
    },
    getChainId: async () => 10_143,
  };
  const throttled = withThrottledReads(client, 1);
  const values = await Promise.all([1, 2, 3].map((value) => throttled.readContract({ value })));

  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(peak, 1);
  assert.equal(await throttled.getChainId(), 10_143);
});
