import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const marketListSource = readFileSync(new URL("./market-list.ts", import.meta.url), "utf8");
const marketSelectorSource = readFileSync(
  new URL("../../components/markets/market-selector.tsx", import.meta.url),
  "utf8",
);
const tradingScreenSource = readFileSync(
  new URL("../../components/trading/trading-screen.tsx", import.meta.url),
  "utf8",
);

describe("listed token icons", () => {
  it("maps the Monad testnet USDT token to the Tether logo", () => {
    assert.match(
      marketListSource,
      /const tetherIconUrl\s*=\s*\n\s*"[^"]+\/blockchains\/ethereum\/assets\/0xdAC17F958D2ee523a2206206994597C13D831ec7\/logo\.png"/,
    );
    assert.match(
      marketListSource,
      /\["0xef271f6433E05757A94e28873911Af92f0D0b9f3"\.toLowerCase\(\)\]:\s*tetherIconUrl/,
    );
  });

  it("renders address-mapped icons in the current market selector before the market list is ready", () => {
    assert.match(tradingScreenSource, /listedTokenIconUrl\(chainId,\s*pool\.baseAsset\)/);
    assert.match(tradingScreenSource, /listedTokenIconUrl\(chainId,\s*pool\.quoteAsset\)/);
    assert.match(marketSelectorSource, /currentMarket\?\.baseIconUrl\s*\?\?\s*currentBaseIconUrl/);
    assert.match(marketSelectorSource, /currentMarket\?\.quoteIconUrl\s*\?\?\s*currentQuoteIconUrl/);
    assert.match(marketSelectorSource, /currentMarket\s*\|\|\s*baseIconUrl\s*\|\|\s*quoteIconUrl/);
  });
});
