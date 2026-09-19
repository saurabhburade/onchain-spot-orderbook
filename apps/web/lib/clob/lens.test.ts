import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { encodeFunctionData, zeroAddress } from "viem";

const require = createRequire(import.meta.url);
const { clobAbi, clobLensAbi } = require("../../config/abis/clob.ts") as typeof import("../../config/abis/clob");

const orderStateComponents = [
  ["quantity", "uint128"],
  ["filledQuantity", "uint128"],
  ["createdAt", "uint64"],
  ["status", "uint8"],
  ["kind", "uint8"],
  ["filledQuoteQuantity", "uint256"],
];

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

test("direct and lens order reads expose the complete OrderState", () => {
  const getOrder = clobAbi.find((item) => item.name === "getOrder");
  assert(getOrder && "outputs" in getOrder);
  const directState = getOrder.outputs.find((output) => output.name === "state");
  assert(directState?.type === "tuple");

  const getUserOrders = clobLensAbi.find((item) => item.name === "getUserOrders");
  assert(getUserOrders && "outputs" in getUserOrders);
  const lensOrders = getUserOrders.outputs.find((output) => output.name === "orders");
  assert(lensOrders?.type === "tuple[]");
  const lensState = lensOrders.components.find((component) => component.name === "state");
  assert(lensState?.type === "tuple");

  const componentSignature = (components: readonly { name: string; type: string }[]) =>
    components.map(({ name, type }) => [name, type]);
  assert.deepEqual(componentSignature(directState.components), orderStateComponents);
  assert.deepEqual(componentSignature(lensState.components), orderStateComponents);
});
