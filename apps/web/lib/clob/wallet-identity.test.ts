import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const walletButtonSource = readFileSync(new URL("../../components/wallet-button.tsx", import.meta.url), "utf8");
const fundingDialogSource = readFileSync(
  new URL("../../components/trading/funding-dialog.tsx", import.meta.url),
  "utf8",
);
const appHeaderSource = readFileSync(new URL("../../components/app-header.tsx", import.meta.url), "utf8");
const walletContextSource = readFileSync(new URL("./wallet.tsx", import.meta.url), "utf8");
const hooksSource = readFileSync(new URL("./hooks.tsx", import.meta.url), "utf8");

test("exposes only the canonical trading identity on Monad", () => {
  assert.match(walletButtonSource, /const address = tradingAddress/);
  assert.doesNotMatch(walletButtonSource, /Privy signer|Alchemy trading account/);
  assert.doesNotMatch(appHeaderSource, /SpotWalletButton/);
  assert.match(walletContextSource, /const tradingAddress = wallet \? getAddress\(wallet\.address\) : null/);
  assert.doesNotMatch(walletContextSource, /requestAlchemyTradingAccount|tradingAccountProof/);
  assert.doesNotMatch(hooksSource, /prepareAlchemySponsoredCalls|sendAlchemySponsoredCalls|sendAlchemyOrder/);
  assert.match(hooksSource, /sendPrivySponsoredCalls/);
});

test("manages embedded wallet funding from the connected wallet menu", () => {
  assert.match(walletButtonSource, /Deposit assets/);
  assert.match(walletButtonSource, /Withdraw assets/);
  assert.match(walletButtonSource, /<FundingDialog/);
  assert.doesNotMatch(walletButtonSource, />\s*Wallet address\s*</);
  assert.doesNotMatch(walletButtonSource, /isCorrectChain \? config\.chain\.name/);
});

test("withdraws selectable native and imported ERC-20 assets", () => {
  assert.match(fundingDialogSource, /Withdraw asset/);
  assert.match(fundingDialogSource, /role="combobox"/);
  assert.match(fundingDialogSource, /Search tokens or paste address/);
  assert.match(fundingDialogSource, /Import token/);
  assert.match(fundingDialogSource, /asset\.balance/);
  assert.match(walletButtonSource, /functionName: "transfer"/);
  assert.match(walletButtonSource, /functionName: "balanceOf"/);
});

test("reads token balances and orders only for the trading address", () => {
  const balanceSource = hooksSource.split("export function useBalances")[1]?.split("function orderStatus")[0] ?? "";
  const orderSource =
    hooksSource.split("export function useUserOrders")[1]?.split("export function useOpenOrders")[0] ?? "";
  assert.match(balanceSource, /args:\s*\[tradingAddress/);
  assert.doesNotMatch(balanceSource, /wallet\.address/);
  assert.match(orderSource, /const walletAddress = tradingAddress/);
  assert.doesNotMatch(orderSource, /wallet\.address/);
});

test("preserves the wallet menu morph and presence interaction contract", () => {
  const triggerClassName = walletButtonSource.match(/<Menu\.Trigger[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
  const popupClassName = walletButtonSource.match(/<Menu\.Popup[\s\S]*?className="([^"]+)"/)?.[1] ?? "";

  assert.ok(triggerClassName, "wallet menu trigger should expose styling hooks");
  assert.ok(popupClassName, "wallet menu popup should expose styling hooks");

  // Base UI provides the shared popup transform origin from its positioner.
  assert.match(walletButtonSource, /<Menu\.Positioner[\s\S]*align="end"[\s\S]*sideOffset=\{8\}/);
  assert.match(popupClassName, /origin-\(--transform-origin\)/);
  assert.match(popupClassName, /transition-\[transform,translate,scale,opacity,filter,border-radius\]/);
  assert.match(popupClassName, /ease-\[cubic-bezier\(0\.16,1,0\.3,1\)\]/);

  // The popup unfolds from the trigger-facing corner, then separates into its own surface.
  // Ending styles keep it present long enough for a shorter, softer close.
  assert.match(walletButtonSource, /<Menu\.Portal>[\s\S]*<Menu\.Popup/);
  assert.match(popupClassName, /data-starting-style:scale-x-75/);
  assert.match(popupClassName, /data-starting-style:scale-y-75/);
  assert.match(popupClassName, /data-ending-style:scale-x-96/);
  assert.match(popupClassName, /data-ending-style:scale-y-96/);
  assert.match(popupClassName, /data-starting-style:translate-y-\[-8px\]/);
  assert.match(popupClassName, /data-ending-style:translate-y-\[-2px\]/);
  assert.match(popupClassName, /data-starting-style:opacity-0/);
  assert.match(popupClassName, /data-ending-style:opacity-0/);
  assert.match(popupClassName, /data-starting-style:blur-\[3px\]/);
  assert.match(popupClassName, /data-ending-style:blur-\[1px\]/);
  assert.match(popupClassName, /data-ending-style:ease-\[cubic-bezier\(0\.4,0,0\.2,1\)\]/);
  assert.match(popupClassName, /motion-reduce:transition-none/);
  assert.match(popupClassName, /motion-reduce:data-starting-style:translate-y-0/);
  assert.match(popupClassName, /motion-reduce:data-ending-style:translate-y-0/);
  assert.match(popupClassName, /motion-reduce:data-starting-style:scale-x-100/);
  assert.match(popupClassName, /motion-reduce:data-starting-style:scale-y-100/);
  assert.match(popupClassName, /motion-reduce:data-ending-style:scale-x-100/);
  assert.match(popupClassName, /motion-reduce:data-ending-style:scale-y-100/);

  const chevronClassName = walletButtonSource.match(/<ChevronDown[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
  assert.match(chevronClassName, /transition-transform/);
  assert.match(chevronClassName, /group-data-popup-open:rotate-180/);
  assert.match(chevronClassName, /motion-reduce:transition-none/);
  assert.match(triggerClassName, /group/);
  assert.match(triggerClassName, /data-popup-open:bg-muted/);
  assert.doesNotMatch(triggerClassName, /scale/);
  assert.doesNotMatch(triggerClassName, /transform/);

  // Menu.Trigger supplies its ARIA expanded/open state; retain the stable accessible name and decorative icon semantics.
  assert.match(
    walletButtonSource,
    /<Menu\.Trigger[\s\S]*aria-label=\{`Wallet \$\{shortenAddress\(address\)\} on \$\{config\.chain\.name\}`\}/,
  );
  assert.match(walletButtonSource, /<ChevronDown[\s\S]*aria-hidden="true"/);
  assert.match(walletButtonSource, /data-popup-open/);
});
