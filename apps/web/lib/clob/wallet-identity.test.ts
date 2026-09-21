import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const walletButtonSource = readFileSync(new URL("../../components/wallet-button.tsx", import.meta.url), "utf8");
const fundingDialogSource = readFileSync(
  new URL("../../components/trading/funding-dialog.tsx", import.meta.url),
  "utf8",
);
const appHeaderSource = readFileSync(new URL("../../components/app-header.tsx", import.meta.url), "utf8");
const chainSwitcherSource = readFileSync(new URL("../../components/chain-switcher.tsx", import.meta.url), "utf8");
const floatingMenuStylesSource = readFileSync(
  new URL("../../components/ui/floating-menu-styles.ts", import.meta.url),
  "utf8",
);
const themeToggleSource = readFileSync(new URL("../../components/theme-toggle.tsx", import.meta.url), "utf8");
const privyConfigSource = readFileSync(new URL("../../config/privy.ts", import.meta.url), "utf8");
const walletContextSource = readFileSync(new URL("./wallet.tsx", import.meta.url), "utf8");
const hooksSource = readFileSync(new URL("../../hooks/use-clob.tsx", import.meta.url), "utf8");

test("matches Privy dialogs to the app's neutral light and dark palettes", () => {
  assert.match(privyConfigSource, /dark:\s*\{\s*accentColor:\s*"#e5e5e5",\s*theme:\s*"#111111"/);
  assert.match(privyConfigSource, /light:\s*\{\s*accentColor:\s*"#262626",\s*theme:\s*"#fafafa"/);
  assert.match(privyConfigSource, /appearance:\s*\{\s*\.\.\.appearance,/);
});

test("isolates the Privy trading wallet from the connected external EOA", () => {
  assert.match(walletButtonSource, /const address = tradingAddress/);
  assert.match(walletButtonSource, /const eoaAddress = connectedEoaAddress/);
  assert.doesNotMatch(walletButtonSource, /Privy signer|Alchemy trading account/);
  assert.doesNotMatch(appHeaderSource, /SpotWalletButton/);
  assert.match(walletContextSource, /const privyWallet = ethereumWallets\.find\(isPrivyWallet\)/);
  assert.match(walletContextSource, /const externalWallets = ethereumWallets\.filter/);
  assert.match(walletContextSource, /return \{ connectedEoaWallet, wallet: privyWallet \}/);
  assert.match(walletContextSource, /const connectedEoaAddress = connectedEoaWallet/);
  assert.match(walletContextSource, /const tradingAddress = wallet \? getAddress\(wallet\.address\) : null/);
  assert.doesNotMatch(walletContextSource, /requestAlchemyTradingAccount|tradingAccountProof/);
  assert.doesNotMatch(hooksSource, /prepareAlchemySponsoredCalls|sendAlchemySponsoredCalls|sendAlchemyOrder/);
  assert.match(hooksSource, /sendPrivySponsoredCalls/);
});

test("keeps EOA identity actions separate from Privy funding actions", () => {
  const connectedMenusSource =
    walletButtonSource.split("if (connected && address)")[1]?.split("<FundingDialog")[0] ?? "";
  const [eoaMenuSource = "", tradingMenuSource = ""] = connectedMenusSource.split("aria-label={`Open trading wallet");

  assert.match(walletButtonSource, /<Wallet aria-hidden="true"/);
  assert.match(eoaMenuSource, /Connected wallet/);
  assert.doesNotMatch(eoaMenuSource, /connectedEoaWallet\.meta\.name/);
  assert.match(eoaMenuSource, /EOA address/);
  assert.match(eoaMenuSource, /Copy EOA address/);
  assert.match(eoaMenuSource, /Disconnect EOA/);
  assert.doesNotMatch(eoaMenuSource, /<dt[^>]*>Network<\/dt>/);
  assert.doesNotMatch(eoaMenuSource, /Connected EOA|EOA on wrong network/);
  assert.doesNotMatch(eoaMenuSource, /Deposit assets|Withdraw assets/);
  assert.match(tradingMenuSource, /Privy Trading Wallet/);
  assert.match(tradingMenuSource, /Trading address/);
  assert.match(tradingMenuSource, /Deposit assets/);
  assert.match(tradingMenuSource, /Withdraw assets/);
  assert.match(tradingMenuSource, /Copy trading address/);
  assert.doesNotMatch(tradingMenuSource, /<dt[^>]*>Network<\/dt>/);
  assert.doesNotMatch(tradingMenuSource, /Ready to trade|Privy wallet|Privy address/);
  assert.match(walletButtonSource, /<FundingDialog/);
  assert.match(walletButtonSource, /<FundingDialog[\s\S]*address=\{address\}/);
  assert.doesNotMatch(walletButtonSource, />\s*Wallet address\s*</);
  assert.doesNotMatch(walletButtonSource, /isCorrectChain \? config\.chain\.name/);
});

test("uses a primary external-wallet action when no EOA is connected", () => {
  const disconnectedEoaStart = walletButtonSource.indexOf('aria-label="Connect an external EOA wallet"');
  const disconnectedEoaEnd = walletButtonSource.indexOf("<Menu.Root>", disconnectedEoaStart);
  const disconnectedEoaSource = walletButtonSource.slice(disconnectedEoaStart, disconnectedEoaEnd);

  assert.ok(disconnectedEoaStart >= 0);
  assert.ok(disconnectedEoaEnd > disconnectedEoaStart);
  assert.match(disconnectedEoaSource, /aria-label="Connect an external EOA wallet"/);
  assert.match(disconnectedEoaSource, /<Wallet[^>]*data-icon="inline-start"[^>]*strokeWidth=\{2\.25\}/);
  assert.match(disconnectedEoaSource, /connecting \? "Connecting…" : "Connect wallet"/);
  assert.match(disconnectedEoaSource, /variant="default"/);
  assert.doesNotMatch(disconnectedEoaSource, /size="icon"/);
});

test("keeps the fully disconnected wallet action primary and icon-labeled", () => {
  const connectedComponentSource = walletButtonSource.split("export function WalletButton")[0] ?? "";
  const fullyDisconnectedSource = connectedComponentSource.split("\n  return (").at(-1) ?? "";

  assert.match(fullyDisconnectedSource, /aria-label="Connect an external EOA wallet"/);
  assert.match(fullyDisconnectedSource, /variant="default"/);
  assert.match(fullyDisconnectedSource, /<Wallet[^>]*strokeWidth=\{2\.25\}/);
  assert.match(fullyDisconnectedSource, /connecting \? "Connecting…" : "Connect wallet"/);
});

test("keeps loading and unavailable wallet states off the primary background", () => {
  const loadingSource =
    walletButtonSource.split("if (connected && !address)")[1]?.split("if (connected && address)")[0] ?? "";
  const unavailableSource = walletButtonSource.split("if (!configured)")[1] ?? "";

  assert.match(loadingSource, /Loading wallet…/);
  assert.match(loadingSource, /variant="outline"/);
  assert.doesNotMatch(loadingSource, /bg-primary/);
  assert.match(unavailableSource, /variant="outline"/);
  assert.doesNotMatch(unavailableSource, /bg-primary/);
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

test("sponsors configured Monad ERC-20 withdrawals", () => {
  const withdrawSource =
    walletButtonSource.split("async function withdraw")[1]?.split("if (connected && !address)")[0] ?? "";
  assert.match(withdrawSource, /config\.chain\.id === MONAD_TESTNET_CHAIN_ID/);
  assert.match(withdrawSource, /config\.faucetTokens\.some/);
  assert.match(withdrawSource, /sendPrivySponsoredCalls/);
  assert.match(withdrawSource, /waitForPrivyTransaction/);
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

test("uses an icon trigger for the EOA and an address trigger for Privy", () => {
  const triggerClassNames = [...walletButtonSource.matchAll(/<Menu\.Trigger[\s\S]*?className="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const popupClassName = floatingMenuStylesSource.match(/const floatingMenuPopupClassName =\s*"([^"]+)"/)?.[1] ?? "";
  const [eoaTriggerClassName = "", privyTriggerClassName = ""] = triggerClassNames;
  const eoaTriggerSource = walletButtonSource.split("<Menu.Trigger")[1]?.split("</Menu.Trigger>")[0] ?? "";
  const tradingTriggerSource = walletButtonSource.split("<Menu.Trigger")[2]?.split("</Menu.Trigger>")[0] ?? "";

  assert.equal(triggerClassNames.length, 2, "EOA and Privy should have distinct menu triggers");
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

  assert.match(eoaTriggerClassName, /size-8/);
  assert.match(eoaTriggerClassName, /rounded-full/);
  assert.match(eoaTriggerClassName, /border-border/);
  assert.match(eoaTriggerClassName, /bg-secondary/);
  assert.match(eoaTriggerClassName, /dark:bg-secondary/);
  assert.match(eoaTriggerClassName, /dark:hover:bg-secondary\/70/);
  assert.match(eoaTriggerClassName, /active:scale-\[0\.96\]/);
  assert.match(eoaTriggerClassName, /data-popup-open:bg-secondary\/70/);
  assert.match(privyTriggerClassName, /h-8/);
  assert.match(privyTriggerClassName, /px-4/);
  assert.match(privyTriggerClassName, /data-popup-open:bg-muted/);
  assert.doesNotMatch(tradingTriggerSource, /size-1\.5 rounded-full/);

  // The icon button owns external EOA details; the address pill owns Privy funding and wallet management.
  assert.match(
    walletButtonSource,
    /<Menu\.Trigger[\s\S]*aria-label=\{`Open wallet details for \$\{shortenAddress\(eoaAddress\)\}`\}/,
  );
  assert.match(walletButtonSource, /<Menu\.Trigger[\s\S]*<Wallet aria-hidden="true"/);
  assert.match(eoaTriggerSource, /<Wallet aria-hidden="true" className="size-4" strokeWidth=\{2\.25\}/);
  assert.match(
    walletButtonSource,
    /<Menu\.Trigger[\s\S]*aria-label=\{`Open trading wallet \$\{shortenAddress\(address\)\}`\}/,
  );
  assert.match(walletButtonSource, /<ChevronDown[\s\S]*group-data-popup-open:rotate-180/);
  assert.match(walletButtonSource, /data-popup-open/);
});

test("shares the wallet dropdown surface and motion with the network selector", () => {
  assert.match(walletButtonSource, /floatingMenuPopupClassName/);
  assert.match(walletButtonSource, /floatingMenuItemClassName/);
  assert.match(chainSwitcherSource, /floatingMenuPopupClassName/);
  assert.match(chainSwitcherSource, /floatingMenuItemClassName/);
  assert.match(chainSwitcherSource, /sideOffset=\{8\}/);
  assert.match(chainSwitcherSource, /w-\(--anchor-width\)/);
  assert.match(floatingMenuStylesSource, /rounded-xl border border-border bg-popover p-1\.5/);
  assert.match(floatingMenuStylesSource, /transition-\[transform,translate,scale,opacity,filter,border-radius\]/);
  assert.match(floatingMenuStylesSource, /data-starting-style:scale-x-75/);
  assert.match(floatingMenuStylesSource, /data-ending-style:scale-x-96/);
});

test("places the connected EOA before the theme control at the end of the header", () => {
  const headerActions = appHeaderSource.split('className="ml-auto flex items-center gap-2"')[1] ?? "";

  assert.ok(headerActions.indexOf("<ChainSwitcher") < headerActions.indexOf("<WalletButton"));
  assert.ok(headerActions.indexOf("<WalletButton") < headerActions.indexOf("<ThemeToggle"));
  assert.match(walletButtonSource, /<div className="contents">/);
  assert.match(walletButtonSource, /Open wallet details[\s\S]*className="order-last/);
  assert.match(walletButtonSource, /aria-label="Connect an external EOA wallet"[\s\S]*className="order-last/);
  assert.match(themeToggleSource, /className="order-last/);
});

test("keeps funding dialog content stable during its close animation", () => {
  const popupSource = fundingDialogSource.split("<Dialog.Popup")[2] ?? "";
  const closeDialogSource =
    fundingDialogSource.split("function closeDialog()")[1]?.split("function resetDialogState")[0] ?? "";

  assert.match(fundingDialogSource, /const lastAction = useRef<FundingAction>/);
  assert.match(fundingDialogSource, /const displayedAction = action \?\? lastAction\.current/);
  assert.match(popupSource, /displayedAction === "deposit"/);
  assert.doesNotMatch(popupSource, /action === "deposit"/);
  assert.doesNotMatch(closeDialogSource, /setRecipient|setAmount|setCopied|setError/);
  assert.match(fundingDialogSource, /onOpenChangeComplete=\{\(open\) => \{[\s\S]*if \(!open\) resetDialogState\(\)/);
  assert.match(popupSource, /transition-\[scale,opacity\]/);
  assert.match(popupSource, /ease-out/);
  assert.match(popupSource, /data-ending-style:scale-\[0\.98\]/);
  assert.doesNotMatch(popupSource, /data-ending-style:scale-95/);
});

test("keeps deposit, withdrawal, and close transitions isolated", () => {
  const closeDialogSource =
    fundingDialogSource.split("function closeDialog()")[1]?.split("function selectAsset")[0] ?? "";

  assert.match(walletButtonSource, /onClick=\{\(\) => setFundingAction\("deposit"\)\}/);
  assert.match(walletButtonSource, /onClick=\{\(\) => setFundingAction\("withdraw"\)\}/);
  assert.match(closeDialogSource, /onActionChange\(null\)/);
  assert.doesNotMatch(closeDialogSource, /"(?:deposit|withdraw)"/);
  assert.match(fundingDialogSource, /<TokenSelector[\s\S]*onOpenChange=\{setAssetSelectorOpen\}/);
});
