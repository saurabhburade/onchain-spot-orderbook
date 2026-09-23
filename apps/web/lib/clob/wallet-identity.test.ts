import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const walletButtonSource = readFileSync(new URL("../../components/wallet-button.tsx", import.meta.url), "utf8");
const fundingDialogSource = readFileSync(
  new URL("../../views/trading/components/funding-dialog.tsx", import.meta.url),
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
const accountHooksSource = readFileSync(new URL("../../hooks/clob/account-hooks.tsx", import.meta.url), "utf8");
const transactionHooksSource = readFileSync(new URL("../../hooks/clob/transaction-hooks.tsx", import.meta.url), "utf8");
const hooksSource = `${accountHooksSource}\n${transactionHooksSource}`;

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

test("keeps EOA identity actions in the Privy wallet menu", () => {
  const connectedMenuSource =
    walletButtonSource.split("if (connected && address)")[1]?.split("<FundingDialog")[0] ?? "";

  assert.match(walletButtonSource, /<Wallet aria-hidden="true"/);
  assert.match(connectedMenuSource, /aria-label=\{`Open trading wallet/);
  assert.match(connectedMenuSource, /Privy Trading Wallet/);
  assert.match(connectedMenuSource, /Trading address/);
  assert.match(connectedMenuSource, /EOA address/);
  assert.match(connectedMenuSource, /Deposit assets/);
  assert.match(connectedMenuSource, /Withdraw assets/);
  assert.match(connectedMenuSource, /Copy trading address/);
  assert.match(connectedMenuSource, /Copy EOA address/);
  assert.doesNotMatch(connectedMenuSource, /Disconnect EOA/);
  assert.equal(connectedMenuSource.match(/Log out/g)?.length, 1);
  assert.doesNotMatch(connectedMenuSource, /<dt[^>]*>Network<\/dt>/);
  assert.doesNotMatch(connectedMenuSource, /Ready to trade|Privy wallet|Privy address/);
  assert.match(walletButtonSource, /<FundingDialog/);
  assert.match(walletButtonSource, /<FundingDialog[\s\S]*address=\{address\}/);
  assert.doesNotMatch(walletButtonSource, />\s*Wallet address\s*</);
  assert.doesNotMatch(walletButtonSource, /isCorrectChain \? config\.chain\.name/);
});

test("does not offer an embedded-only EOA connection state", () => {
  const connectedMenuSource =
    walletButtonSource.split("if (connected && address)")[1]?.split("<FundingDialog")[0] ?? "";

  assert.doesNotMatch(connectedMenuSource, /Connect EOA/);
  assert.doesNotMatch(connectedMenuSource, /aria-label="Connect an external EOA wallet"/);
  assert.doesNotMatch(connectedMenuSource, /className="order-last/);
  assert.doesNotMatch(connectedMenuSource, /variant="default"/);
});

test("logs out the Privy session when no external EOA remains connected", () => {
  assert.match(walletContextSource, /const EOA_LOGOUT_GRACE_MS = 1_000/);
  assert.match(
    walletContextSource,
    /if \(!ready \|\| !authenticated \|\| isModalOpen \|\| !tradingAddress \|\| connectedEoaAddress\) return/,
  );
  assert.match(
    walletContextSource,
    /window\.setTimeout\(\(\) => \{\s*clearKernelSessionKey\(\);\s*void logout\(\)\.catch/,
  );
  assert.match(walletContextSource, /return \(\) => window\.clearTimeout\(timeout\)/);
});

test("pre-authorizes the local Kernel session when login completes", () => {
  assert.match(walletContextSource, /prepareKernelSessionKey/);
  assert.match(walletContextSource, /wallet\s*\.getEthereumProvider\(\)/);
  assert.match(walletContextSource, /config\.chain\.id !== 10_143/);
  assert.match(walletContextSource, /const SESSION_RENEWAL_LEAD_MS = 5 \* 60 \* 1_000/);
  assert.match(walletContextSource, /session\.validUntil \* 1_000 - Date\.now\(\) - SESSION_RENEWAL_LEAD_MS/);
  assert.match(walletContextSource, /clearKernelSessionKey\(config\.chain\.id, tradingAddress\)/);
  assert.match(walletContextSource, /Could not pre-authorize the Kernel session key/);
  assert.match(walletContextSource, /window\.addEventListener\("focus", authorizeSessionOnFocus\)/);
  assert.match(walletContextSource, /document\.addEventListener\("visibilitychange", authorizeSessionWhenVisible\)/);
  assert.match(walletContextSource, /window\.removeEventListener\("focus", authorizeSessionOnFocus\)/);
  assert.match(walletContextSource, /document\.removeEventListener\("visibilitychange", authorizeSessionWhenVisible\)/);
  assert.match(walletContextSource, /getAccessToken\(\)/);
  assert.match(walletContextSource, /warmDirectUserOperationAuth/);
  assert.match(walletContextSource, /Could not warm the sponsored UserOperation authentication/);
  assert.match(walletContextSource, /const AUTH_WARM_INTERVAL_MS = 10 \* 60 \* 1_000/);
  assert.match(walletContextSource, /window\.setInterval\(warmAuthentication, AUTH_WARM_INTERVAL_MS\)/);
  assert.match(walletContextSource, /window\.addEventListener\("focus", warmAuthentication\)/);
  assert.match(walletContextSource, /document\.addEventListener\("visibilitychange", warmAuthenticationWhenVisible\)/);
  assert.match(walletContextSource, /window\.clearInterval\(authWarmTimer\)/);
});

test("keeps Privy root signing out of every transaction path", () => {
  const submitSource =
    transactionHooksSource
      .split("const submitDirectCalls = useCallback")[1]
      ?.split("const placeOrder = useCallback")[0] ?? "";
  const withdrawSource =
    walletButtonSource.split("async function withdraw")[1]?.split("if (connected && !address)")[0] ?? "";

  assert.doesNotMatch(submitSource, /getEthereumProvider/);
  assert.doesNotMatch(withdrawSource, /getEthereumProvider/);
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

test("sponsors every Monad native and ERC-20 withdrawal", () => {
  const withdrawSource =
    walletButtonSource.split("async function withdraw")[1]?.split("if (connected && !address)")[0] ?? "";
  assert.match(withdrawSource, /config\.chain\.id === MONAD_TESTNET_CHAIN_ID/);
  assert.match(withdrawSource, /submitDirectUserOperationWithSessionKey/);
  assert.match(withdrawSource, /onAccountNotDelegated/);
  assert.match(withdrawSource, /\[\{ to: getAddress\(recipient\), value \}\]/);
  assert.match(withdrawSource, /if\s*\(!canSponsor\)\s*await publicClient\.waitForTransactionReceipt/);
});

test("reads token balances and orders only for the trading address", () => {
  const balanceSource =
    accountHooksSource.split("export function useBalances")[1]?.split("function orderStatus")[0] ?? "";
  const orderSource =
    accountHooksSource.split("export function useUserOrders")[1]?.split("export function useOpenOrders")[0] ?? "";
  assert.match(balanceSource, /args:\s*\[tradingAddress/);
  assert.doesNotMatch(balanceSource, /wallet\.address/);
  assert.match(orderSource, /const walletAddress = tradingAddress/);
  assert.doesNotMatch(orderSource, /wallet\.address/);
});

test("uses one address trigger for the unified wallet menu", () => {
  const triggerClassNames = [...walletButtonSource.matchAll(/<Menu\.Trigger[\s\S]*?className="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const popupClassName = floatingMenuStylesSource.match(/const floatingMenuPopupClassName =\s*"([^"]+)"/)?.[1] ?? "";
  const [privyTriggerClassName = ""] = triggerClassNames;
  const tradingTriggerSource = walletButtonSource.split("<Menu.Trigger")[1]?.split("</Menu.Trigger>")[0] ?? "";

  assert.equal(triggerClassNames.length, 1, "EOA and Privy should share one menu trigger");
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

  assert.match(privyTriggerClassName, /h-8/);
  assert.match(privyTriggerClassName, /px-4/);
  assert.match(privyTriggerClassName, /data-popup-open:bg-muted/);
  assert.doesNotMatch(tradingTriggerSource, /size-1\.5 rounded-full/);

  // The single address pill owns both EOA identity details and Privy wallet actions.
  assert.doesNotMatch(walletButtonSource, /Open wallet details/);
  assert.match(
    walletButtonSource,
    /<Menu\.Trigger[\s\S]*aria-label=\{`Open trading wallet \$\{shortenAddress\(address\)\}`\}/,
  );
  assert.match(tradingTriggerSource, /<ChevronDown[\s\S]*group-data-popup-open:rotate-180/);
  assert.match(walletButtonSource, /data-popup-open/);
});

test("shares the wallet dropdown surface and motion with the network selector", () => {
  assert.match(walletButtonSource, /floatingMenuPopupClassName/);
  assert.match(walletButtonSource, /floatingMenuItemClassName/);
  assert.match(chainSwitcherSource, /floatingMenuPopupClassName/);
  assert.match(chainSwitcherSource, /floatingMenuItemClassName/);
  assert.match(chainSwitcherSource, /sideOffset=\{8\}/);
  assert.match(chainSwitcherSource, /min-w-40/);
  assert.match(floatingMenuStylesSource, /rounded-xl border border-border bg-popover p-1\.5/);
  assert.match(floatingMenuStylesSource, /transition-\[transform,translate,scale,opacity,filter,border-radius\]/);
  assert.match(floatingMenuStylesSource, /data-starting-style:scale-x-75/);
  assert.match(floatingMenuStylesSource, /data-ending-style:scale-x-96/);
});

test("places the unified wallet control before the theme control at the end of the header", () => {
  const headerActions = appHeaderSource.split('className="ml-auto flex items-center gap-2"')[1] ?? "";

  assert.ok(headerActions.indexOf("<ChainSwitcher") < headerActions.indexOf("<WalletButton"));
  assert.ok(headerActions.indexOf("<WalletButton") < headerActions.indexOf("<ThemeToggle"));
  assert.match(walletButtonSource, /<div className="contents">/);
  assert.match(walletButtonSource, /aria-label="Connect an external EOA wallet"/);
  assert.doesNotMatch(walletButtonSource, /Open wallet details/);
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
