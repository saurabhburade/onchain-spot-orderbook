import { type Address, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Hex } from "viem";

export const LEGACY_DEFAULT_LOT_DECIMALS = 8;
export const LOW_PRICE_LOT_TOKENS = 100_000n;
const MAX_UINT128 = (1n << 128n) - 1n;
export const AGNOSTIC_CREATE_PAIR_SELECTOR = "0xc9c65396" as Hex;
export const LEGACY_CREATE_PAIR_SELECTOR = "0xc88fd935" as Hex;

export function hasFunctionSelector(bytecode: Hex | undefined, selector: Hex) {
  return Boolean(bytecode?.toLowerCase().includes(selector.slice(2).toLowerCase()));
}

export function legacyCreatePairArgs(baseAsset: Address, quoteAsset: Address) {
  return [baseAsset, quoteAsset, 1n, 1, 0xffffff] as const;
}

function hasCause(error: unknown, predicate: (cause: unknown) => boolean): boolean {
  if (!error || typeof error !== "object") return false;
  if (predicate(error)) return true;
  if (!("cause" in error)) return false;
  return hasCause((error as { cause?: unknown }).cause, predicate);
}

/** Treat only empty-data contract reverts as an absent legacy function. */
export function isUnsupportedContractFunctionError(error: unknown) {
  return hasCause(
    error,
    (cause) =>
      cause instanceof ContractFunctionZeroDataError ||
      (cause instanceof ContractFunctionRevertedError && (!cause.raw || cause.raw === "0x")),
  );
}

export function legacyLotConfiguration(baseDecimals: number) {
  const lotDecimals = Math.min(LEGACY_DEFAULT_LOT_DECIMALS, baseDecimals);
  return {
    lotDecimals,
    lotSize: 10n ** BigInt(baseDecimals - lotDecimals),
  };
}

/** One 100,000-token lot lets one 6-decimal quote atom settle at 0.00000000001 per token. */
export function lowPriceLotSize(baseDecimals: number) {
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0) throw new Error("Invalid base-token decimals");
  const lotSize = LOW_PRICE_LOT_TOKENS * 10n ** BigInt(baseDecimals);
  if (lotSize > MAX_UINT128) throw new Error("Base-token decimals are too large for the low-price lot profile");
  return lotSize;
}

/** The automatic market configuration uses one whole base token per lot. */
export function defaultMarketLotSize(baseDecimals: number) {
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0) throw new Error("Invalid base-token decimals");
  const lotSize = 10n ** BigInt(baseDecimals);
  if (lotSize > MAX_UINT128) throw new Error("Base-token decimals are too large for the default market lot");
  return lotSize;
}
