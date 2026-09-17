import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import type { getLogsInBlockRanges as getLogsInBlockRangesType } from "./log-ranges";

const require = createRequire(import.meta.url);
const { getLogsInBlockRanges } = require("./log-ranges.ts") as {
  getLogsInBlockRanges: typeof getLogsInBlockRangesType;
};

describe("getLogsInBlockRanges", () => {
  it("keeps every eth_getLogs request within the configured block range", async () => {
    const ranges: Array<readonly [bigint, bigint]> = [];
    const client = {
      getBlockNumber: async () => 250n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([fromBlock, toBlock]);
        return [{ blockNumber: fromBlock }];
      },
    };

    const logs = await getLogsInBlockRanges(
      () => client.getBlockNumber(),
      (range) => client.getLogs(range),
      0n,
      100n,
    );

    assert.deepEqual(ranges, [
      [0n, 100n],
      [101n, 201n],
      [202n, 250n],
    ]);
    assert.deepEqual(logs, [{ blockNumber: 0n }, { blockNumber: 101n }, { blockNumber: 202n }]);
  });

  it("returns no logs when the start block is ahead of the chain", async () => {
    let calls = 0;
    const client = {
      getBlockNumber: async () => 9n,
      getLogs: async (_range: { fromBlock: bigint; toBlock: bigint }) => {
        calls += 1;
        return [];
      },
    };

    assert.deepEqual(
      await getLogsInBlockRanges(
        () => client.getBlockNumber(),
        (range) => client.getLogs(range),
        10n,
        100n,
      ),
      [],
    );
    assert.equal(calls, 0);
  });
});
