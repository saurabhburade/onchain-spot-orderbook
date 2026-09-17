import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { encodeFunctionData, zeroAddress } from "viem";

const require = createRequire(import.meta.url);
const { clobAbi, clobLensAbi } = require("./abi.ts") as typeof import("./abi");

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

test("keeps the fresh OrderState tuple order in direct and lens reads", () => {
  const stateNames = ["quantity", "filledQuantity", "createdAt", "status", "kind", "filledQuoteQuantity"];
  const getOrder = clobAbi.find((item) => item.name === "getOrder");
  const getUserOrders = clobLensAbi.find((item) => item.name === "getUserOrders");
  assert(getOrder && "outputs" in getOrder);
  assert(getUserOrders && "outputs" in getUserOrders);

  const directState = getOrder.outputs[1];
  const lensOrders = getUserOrders.outputs[0];
  assert.equal(directState.type, "tuple");
  assert.equal(lensOrders.type, "tuple[]");
  const lensState = lensOrders.components.find((component) => component.name === "state");
  assert(lensState && lensState.type === "tuple");
  assert.deepEqual(
    directState.components.map((component) => component.name),
    stateNames,
  );
  assert.deepEqual(
    lensState.components.map((component) => component.name),
    stateNames,
  );
  assert.equal(directState.components.at(-1)?.type, "uint256");
  assert.equal(lensState.components.at(-1)?.type, "uint256");
});
