import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createAsyncCache, createRequestCoalescer } = require("./async-cache.ts") as typeof import("./async-cache");

describe("RPC read coalescing", () => {
  it("shares one in-flight request between concurrent readers", async () => {
    const cache = createAsyncCache<string, number>();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await Promise.resolve();
      return 42;
    };

    const values = await Promise.all(Array.from({ length: 6 }, () => cache.get("pool", load)));

    assert.deepEqual(values, [42, 42, 42, 42, 42, 42]);
    assert.equal(calls, 1);
  });

  it("evicts a rejected request so a later read can retry", async () => {
    const cache = createAsyncCache<string, number>();
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("rate limited");
      return 42;
    };

    await assert.rejects(cache.get("pool", load), /rate limited/);
    assert.equal(await cache.get("pool", load), 42);
    assert.equal(calls, 2);
  });

  it("shares only concurrent mutable reads and refreshes again afterward", async () => {
    const coalescer = createRequestCoalescer<string, number>();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await Promise.resolve();
      return calls;
    };

    const burst = await Promise.all(Array.from({ length: 6 }, () => coalescer.run("orders", load)));

    assert.deepEqual(burst, [1, 1, 1, 1, 1, 1]);
    assert.equal(calls, 1);
    assert.equal(await coalescer.run("orders", load), 2);
    assert.equal(calls, 2);
  });
});
