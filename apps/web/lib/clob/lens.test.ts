import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { encodeFunctionData, zeroAddress } from "viem";

const require = createRequire(import.meta.url);
const { clobLensAbi } = require("./abi.ts") as typeof import("./abi");

test("lens ABI encodes market snapshot reads", () => {
  const data = encodeFunctionData({
    abi: clobLensAbi,
    functionName: "getMarketSnapshot",
    args: [zeroAddress, zeroAddress, zeroAddress, 20],
  });
  assert.match(data, /^0x[0-9a-f]+$/);
});

test("lens ABI exposes best prices and both book sides", () => {
  const snapshotFunction = clobLensAbi.find((item) => item.name === "getMarketSnapshot");
  assert(snapshotFunction && "outputs" in snapshotFunction);
  const snapshot = snapshotFunction.outputs[0];
  assert.equal(snapshot.type, "tuple");
  assert.deepEqual(
    snapshot.components.map((component) => component.name),
    [
      "market",
      "sequence",
      "bidExists",
      "bidPrice",
      "bidQuantity",
      "askExists",
      "askPrice",
      "askQuantity",
      "bids",
      "asks",
    ],
  );
});
