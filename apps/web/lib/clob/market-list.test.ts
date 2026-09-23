import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const marketListSource = readFileSync(new URL("./market-list.ts", import.meta.url), "utf8");
const marketSelectorSource = readFileSync(
  new URL("../../views/markets/components/market-selector.tsx", import.meta.url),
  "utf8",
);
const marketPairIconSource = readFileSync(
  new URL("../../views/markets/components/market-pair-icon.tsx", import.meta.url),
  "utf8",
);
const tokenIconSource = readFileSync(new URL("../../components/token-icon.tsx", import.meta.url), "utf8");
const createMarketSource = readFileSync(
  new URL("../../views/markets/components/create-market-screen.tsx", import.meta.url),
  "utf8",
);
const fundingDialogSource = readFileSync(
  new URL("../../views/trading/components/funding-dialog.tsx", import.meta.url),
  "utf8",
);
const faucetScreenSource = readFileSync(
  new URL("../../views/token-tools/components/faucet-screen.tsx", import.meta.url),
  "utf8",
);
const tradingScreenSource = readFileSync(
  new URL("../../views/trading/components/trading-screen.tsx", import.meta.url),
  "utf8",
);

describe("listed token icons", () => {
  it("maps the Monad testnet USDT token to the Tether logo", () => {
    assert.match(
      marketListSource,
      /const tetherIconUrl\s*=\s*\n\s*"[^"]+\/blockchains\/ethereum\/assets\/0xdAC17F958D2ee523a2206206994597C13D831ec7\/logo\.png"/,
    );
    assert.match(marketListSource, /\[monadUsdt\.address\.toLowerCase\(\)\]:\s*tetherIconUrl/);
  });

  it("renders address-mapped icons in the current market selector before the market list is ready", () => {
    assert.match(tradingScreenSource, /listedTokenIconUrl\(chainId,\s*pool\.baseAsset\)/);
    assert.match(tradingScreenSource, /listedTokenIconUrl\(chainId,\s*pool\.quoteAsset\)/);
    assert.match(marketSelectorSource, /currentMarket\?\.baseIconUrl\s*\?\?\s*currentBaseIconUrl/);
    assert.match(marketSelectorSource, /currentMarket\?\.quoteIconUrl\s*\?\?\s*currentQuoteIconUrl/);
    assert.match(marketSelectorSource, /currentMarket\s*\|\|\s*baseIconUrl\s*\|\|\s*quoteIconUrl/);
  });

  it("shows the selected market symbols as soon as its listing is available", () => {
    assert.match(
      marketSelectorSource,
      /const selectedMarketLabel = currentMarket \? marketLabel\(currentMarket\) : currentSymbol/,
    );
    assert.match(marketSelectorSource, /\{selectedMarketLabel\}/);
    assert.match(marketPairIconSource, /alt=\{`\$\{baseSymbol\} token icon`\}/);
    assert.match(marketPairIconSource, /alt=\{`\$\{quoteSymbol\} token icon`\}/);
  });

  it("uses the question-badge fallback anywhere a token logo can be unavailable", () => {
    assert.match(tokenIconSource, /BadgeQuestionMark/);
    assert.match(tokenIconSource, /event\.currentTarget\.style\.display = "none"/);
    for (const source of [marketPairIconSource, createMarketSource, fundingDialogSource, faucetScreenSource]) {
      assert.match(source, /TokenIcon/);
    }
    assert.doesNotMatch(marketPairIconSource, /symbol\.trim\(\)\.slice/);
    assert.doesNotMatch(fundingDialogSource, /asset\.symbol\.slice/);
    assert.doesNotMatch(faucetScreenSource, /token\.symbol\.slice/);
  });

  it("scopes browser-listed markets to the active factory deployment", () => {
    assert.match(marketListSource, /clob:listed-markets:v2/);
    assert.match(marketListSource, /factoryAddress\?\.toLowerCase\(\)/);
    assert.doesNotMatch(marketListSource, /clob:listed-markets:v1/);
  });

  it("uses the destructive color for a negative trading-header 24h change", () => {
    assert.match(
      tradingScreenSource,
      /label === "24h change" && summary\.change\?\.startsWith\("-"\)\s*\? "text-destructive"/,
    );
  });
});
