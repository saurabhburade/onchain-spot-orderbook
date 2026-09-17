export type BlockRange = { fromBlock: bigint; toBlock: bigint };

const DEFAULT_REQUEST_BATCH_SIZE = 50;

export async function getLogsInBlockRanges<TLog>(
  getBlockNumber: () => Promise<bigint>,
  getLogs: (range: BlockRange) => Promise<readonly TLog[]>,
  fromBlock: bigint,
  maxBlockRange: bigint,
): Promise<TLog[]> {
  if (maxBlockRange < 0n) throw new Error("Maximum block range cannot be negative");

  const toBlock = await getBlockNumber();
  if (fromBlock > toBlock) return [];

  const ranges: BlockRange[] = [];
  for (let rangeStart = fromBlock; rangeStart <= toBlock; rangeStart += maxBlockRange + 1n) {
    ranges.push({
      fromBlock: rangeStart,
      toBlock: rangeStart + maxBlockRange < toBlock ? rangeStart + maxBlockRange : toBlock,
    });
  }

  const logs: TLog[] = [];
  for (let index = 0; index < ranges.length; index += DEFAULT_REQUEST_BATCH_SIZE) {
    const requestBatch = ranges.slice(index, index + DEFAULT_REQUEST_BATCH_SIZE);
    const results = await Promise.all(requestBatch.map((range) => getLogs(range)));
    for (const result of results) logs.push(...result);
  }
  return logs;
}
