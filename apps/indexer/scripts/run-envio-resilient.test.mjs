import { describe, expect, it } from "vitest";
import { isRetryableRpcFailure } from "./run-envio-resilient.mjs";

describe("isRetryableRpcFailure", () => {
  it.each([
    '"status": 429',
    "50/second request limit reached",
    'type: "EXPONENTIAL_BACKOFF"',
    "Error: read ECONNRESET",
    "TypeError: fetch failed",
  ])("recognizes transient RPC output: %s", (output) => {
    expect(isRetryableRpcFailure(output)).toBe(true);
  });

  it("does not restart a configuration failure", () => {
    expect(isRetryableRpcFailure("Error: invalid config: missing chain id")).toBe(false);
  });
});
