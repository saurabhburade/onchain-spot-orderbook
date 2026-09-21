"use client";

import { Menu } from "@base-ui/react/menu";
import { useAuthorizationSignature, usePrivy, useSendTransaction } from "@privy-io/react-auth";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  LogOut,
  Network,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address, encodeFunctionData, formatUnits, getAddress, type Hash, isAddress, parseUnits } from "viem";

import { usePrivyConfigured } from "@/components/providers";
import { type FundingAction, FundingDialog, type WalletAsset } from "@/components/trading/funding-dialog";
import { Button } from "@/components/ui/button";
import { floatingMenuItemClassName, floatingMenuPopupClassName } from "@/components/ui/floating-menu-styles";
import { erc20Abi, MONAD_TESTNET_CHAIN_ID, useClobChain, useClobWallet } from "@/lib/clob";
import { notifyBalanceRefresh, subscribeToBalanceRefresh } from "@/lib/clob/balance-refresh";
import { sendPrivySponsoredCalls, waitForPrivyTransaction } from "@/lib/clob/privy-wallet-api";

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatBalance(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  const [integer, fraction = ""] = formatted.split(".");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
}

type AssetMetadata = Omit<WalletAsset, "balance" | "balanceRaw">;
const emptyAssetMetadata: AssetMetadata[] = [];
const assetIconUrls: Readonly<Record<string, string>> = {
  MON: "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/monad/info/logo.png",
  USDC: "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/monad/assets/0x754704Bc059F8C67012fEd69BC8A327a5aafb603/logo.png",
  USDT: "https://raw.githubusercontent.com/trustwallet/assets/e99837ebc451d93fdac2ab29fe33aabb0f75c61c/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png",
};
const walletMenuPopupClassName = `w-64 ${floatingMenuPopupClassName}`;
const walletMenuItemClassName = floatingMenuItemClassName;

function PrivyMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="8.5" fill="currentColor" r="6.25" />
      <path
        d="M6.5 18.25c1.18.55 3.02.83 5.5.83s4.32-.28 5.5-.83c.3-.14.64.08.64.4 0 .16-.07.3-.2.4-1.36 1.03-3.1 1.54-5.19 1.54s-3.83-.51-5.19-1.54a.5.5 0 0 1-.2-.4c0-.32.34-.54.64-.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ConnectedWalletButton() {
  const { config, publicClient } = useClobChain();
  const {
    connect,
    connected,
    connectedEoaAddress,
    connectedEoaWallet,
    connectionError,
    connecting,
    disconnect,
    isConnectedEoaCorrectChain,
    isCorrectChain,
    ready,
    switchConnectedEoaToClobChain,
    switchToClobChain,
    tradingAddress,
    wallet,
    walletId,
  } = useClobWallet();
  const { getAccessToken } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const { generateAuthorizationSignature } = useAuthorizationSignature();
  const [copiedEoa, setCopiedEoa] = useState(false);
  const [copiedPrivy, setCopiedPrivy] = useState(false);
  const [fundingAction, setFundingAction] = useState<FundingAction | null>(null);
  const [importedAssetsByChain, setImportedAssetsByChain] = useState<Record<number, AssetMetadata[]>>({});
  const [assetBalances, setAssetBalances] = useState<Record<string, bigint | null>>({});
  const [selectedAssetKeys, setSelectedAssetKeys] = useState<Record<number, string>>({});
  const address = tradingAddress;
  const eoaAddress = connectedEoaAddress;
  const importedAssets = importedAssetsByChain[config.chain.id] ?? emptyAssetMetadata;
  const selectedAssetKey = selectedAssetKeys[config.chain.id] ?? "native";
  const assetMetadata = useMemo<AssetMetadata[]>(() => {
    const configuredAssets: AssetMetadata[] = config.faucetTokens.map((token) => ({
      address: token.address,
      decimals: token.decimals,
      iconUrl: assetIconUrls[token.symbol],
      key: token.address.toLowerCase(),
      name: token.symbol,
      symbol: token.symbol,
    }));
    const uniqueAssets = new Map(configuredAssets.map((asset) => [asset.key, asset]));
    for (const asset of importedAssets) uniqueAssets.set(asset.key, asset);
    return [
      {
        decimals: config.chain.nativeCurrency.decimals,
        iconUrl: assetIconUrls[config.chain.nativeCurrency.symbol],
        key: "native",
        name: config.chain.nativeCurrency.name,
        symbol: config.chain.nativeCurrency.symbol,
      },
      ...uniqueAssets.values(),
    ];
  }, [config.chain.nativeCurrency, config.faucetTokens, importedAssets]);
  const assets = useMemo<WalletAsset[]>(
    () =>
      assetMetadata.map((asset) => {
        const balanceRaw = assetBalances[asset.key] ?? null;
        return {
          ...asset,
          balance: balanceRaw === null ? "—" : formatBalance(balanceRaw, asset.decimals),
          balanceRaw,
        };
      }),
    [assetBalances, assetMetadata],
  );

  const refreshBalances = useCallback(async () => {
    if (!wallet || !isAddress(wallet.address)) {
      setAssetBalances({});
      return;
    }
    const walletAddress = wallet.address as Address;
    const nextBalances = await Promise.all(
      assetMetadata.map(async (asset) => {
        try {
          const balance = asset.address
            ? await publicClient.readContract({
                address: asset.address,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [walletAddress],
              })
            : await publicClient.getBalance({ address: walletAddress });
          return [asset.key, balance] as const;
        } catch {
          return [asset.key, null] as const;
        }
      }),
    );
    setAssetBalances(Object.fromEntries(nextBalances));
  }, [assetMetadata, publicClient, wallet]);

  useEffect(() => {
    void refreshBalances();
    return subscribeToBalanceRefresh(() => void refreshBalances());
  }, [refreshBalances]);

  async function importAsset(tokenAddress: Address): Promise<WalletAsset> {
    if (!wallet || !isAddress(wallet.address)) throw new Error("Connect your wallet first.");
    const address = getAddress(tokenAddress);
    const existing = assets.find((asset) => asset.address?.toLowerCase() === address.toLowerCase());
    if (existing) return existing;

    try {
      const [name, symbol, decimals, balanceRaw] = await publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address, abi: erc20Abi, functionName: "name" },
          { address, abi: erc20Abi, functionName: "symbol" },
          { address, abi: erc20Abi, functionName: "decimals" },
          { address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address as Address] },
        ],
      });
      if (!name.trim() || !symbol.trim()) throw new Error("Token metadata is incomplete.");
      const metadata: AssetMetadata = {
        address,
        decimals,
        key: address.toLowerCase(),
        name,
        symbol,
      };
      setImportedAssetsByChain((current) => ({
        ...current,
        [config.chain.id]: [...(current[config.chain.id] ?? []), metadata],
      }));
      setAssetBalances((current) => ({ ...current, [metadata.key]: balanceRaw }));
      return { ...metadata, balance: formatBalance(balanceRaw, decimals), balanceRaw };
    } catch {
      throw new Error("Could not import this token. Check the contract address and network.");
    }
  }

  async function withdraw(recipient: string, amount: string, asset: WalletAsset) {
    if (!wallet) throw new Error("Connect your wallet first.");
    if (!isAddress(recipient)) throw new Error("Enter a valid recipient address.");

    let value: bigint;
    try {
      value = parseUnits(amount, asset.decimals);
    } catch {
      throw new Error(`Enter a valid ${asset.symbol} amount.`);
    }
    if (value <= 0n) throw new Error("Amount must be greater than zero.");
    if (asset.balanceRaw !== null && value > asset.balanceRaw) {
      throw new Error(`Insufficient ${asset.symbol} balance.`);
    }

    const transferData = asset.address
      ? encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [getAddress(recipient), value],
        })
      : undefined;
    const transaction = asset.address
      ? {
          chainId: config.chain.id,
          data: transferData,
          to: asset.address,
        }
      : {
          chainId: config.chain.id,
          to: getAddress(recipient),
          value,
        };

    const canSponsor =
      config.chain.id === MONAD_TESTNET_CHAIN_ID &&
      asset.address &&
      config.faucetTokens.some((token) => token.address.toLowerCase() === asset.address?.toLowerCase());
    let hash: Hash;
    if (canSponsor && asset.address) {
      if (!walletId) throw new Error("The Privy embedded wallet is not ready.");
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Your Privy session expired before the withdrawal could be submitted.");
      const transactionId = await sendPrivySponsoredCalls({
        accessToken,
        calls: [{ to: asset.address, data: transferData }],
        chainId: config.chain.id,
        generateAuthorizationSignature,
        walletId,
      });
      hash = await waitForPrivyTransaction({ walletId, transactionId, getAccessToken });
    } else {
      ({ hash } = await sendTransaction(transaction, {
        address: wallet.address,
        uiOptions: {
          buttonText: "Confirm withdrawal",
          description: `Withdraw ${amount} ${asset.symbol} to ${recipient}`,
          showWalletUIs: true,
        },
      }));
    }
    await publicClient.waitForTransactionReceipt({ hash });
    notifyBalanceRefresh();
  }

  if (connected && !address) {
    return (
      <Button
        className="order-last h-8 rounded-full px-4 text-xs text-foreground disabled:opacity-70"
        disabled
        title={connectionError ?? "Resolving wallet address"}
        variant="outline"
      >
        {!connectionError ? (
          <LoaderCircle
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
            data-icon="inline-start"
          />
        ) : null}
        {connectionError ? "Wallet unavailable" : "Loading wallet…"}
      </Button>
    );
  }

  if (connected && address) {
    return (
      <>
        <div className="contents">
          {(!eoaAddress || !connectedEoaWallet) && (
            <Button
              aria-label="Connect an external EOA wallet"
              className="order-last h-8 rounded-full px-4 text-xs active:scale-[0.96]"
              disabled={!ready || connecting}
              onClick={connect}
              title="Connect external EOA wallet"
              type="button"
              variant="default"
            >
              {connecting ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              ) : (
                <Wallet aria-hidden="true" className="size-4" data-icon="inline-start" strokeWidth={2.25} />
              )}
              {connecting ? "Connecting…" : "Connect wallet"}
            </Button>
          )}
          <Menu.Root>
            <Menu.Trigger
              aria-label={`Open trading wallet ${shortenAddress(address)}`}
              className="group inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-transparent bg-secondary px-4 text-xs font-medium text-secondary-foreground outline-none transition-[background-color,border-color,box-shadow] hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 data-popup-open:bg-muted"
              disabled={!ready}
            >
              <span className="font-mono tabular-nums">{shortenAddress(address)}</span>
              <ChevronDown
                aria-hidden="true"
                className="size-3.5 text-secondary-foreground/70 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-popup-open:rotate-180 motion-reduce:transition-none"
                strokeWidth={1.5}
              />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner align="end" className="z-50 outline-none" sideOffset={8}>
                <Menu.Popup className={walletMenuPopupClassName}>
                  <div className="px-2.5 py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-foreground">
                        <PrivyMark className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold">Privy Trading Wallet</span>
                        {!isCorrectChain ? (
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
                            Trading wallet on wrong network
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                      <dt className="text-muted-foreground">Account type</dt>
                      <dd className="text-right font-medium">Embedded</dd>
                    </dl>
                    <div className="mt-2.5 rounded-lg bg-muted/70 px-2.5 py-2">
                      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        Trading address
                      </p>
                      <p className="mt-1 break-all font-mono text-[11px] leading-4 tabular-nums">{address}</p>
                    </div>
                    {eoaAddress && connectedEoaWallet ? (
                      <div className="mt-2 rounded-lg bg-muted/70 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                            EOA address
                          </p>
                          {!isConnectedEoaCorrectChain ? (
                            <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
                              Wrong network
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 break-all font-mono text-[11px] leading-4 tabular-nums">{eoaAddress}</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="my-1 h-px bg-border" />
                  <Menu.Item className={walletMenuItemClassName} onClick={() => setFundingAction("deposit")}>
                    <ArrowDownToLine aria-hidden="true" className="size-4" strokeWidth={1.5} />
                    Deposit assets
                  </Menu.Item>
                  <Menu.Item className={walletMenuItemClassName} onClick={() => setFundingAction("withdraw")}>
                    <ArrowUpFromLine aria-hidden="true" className="size-4" strokeWidth={1.5} />
                    Withdraw assets
                  </Menu.Item>
                  <div className="my-1 h-px bg-border" />
                  {!isCorrectChain ? (
                    <Menu.Item
                      aria-label={`Switch trading wallet to ${config.chain.name}`}
                      className={walletMenuItemClassName}
                      onClick={() => void switchToClobChain()}
                    >
                      <Network aria-hidden="true" className="size-4" strokeWidth={1.5} />
                      Switch trading network
                    </Menu.Item>
                  ) : null}
                  <Menu.Item
                    className={walletMenuItemClassName}
                    onClick={() => {
                      void navigator.clipboard.writeText(address).then(() => {
                        setCopiedPrivy(true);
                        window.setTimeout(() => setCopiedPrivy(false), 1500);
                      });
                    }}
                  >
                    {copiedPrivy ? (
                      <Check aria-hidden="true" className="size-4 text-chart-3" strokeWidth={1.5} />
                    ) : (
                      <Copy aria-hidden="true" className="size-4" strokeWidth={1.5} />
                    )}
                    {copiedPrivy ? "Copied address" : "Copy trading address"}
                  </Menu.Item>
                  {eoaAddress && connectedEoaWallet ? (
                    <>
                      <div className="my-1 h-px bg-border" />
                      {!isConnectedEoaCorrectChain ? (
                        <Menu.Item
                          aria-label={`Switch connected EOA to ${config.chain.name}`}
                          className={walletMenuItemClassName}
                          onClick={() => void switchConnectedEoaToClobChain()}
                        >
                          <Network aria-hidden="true" className="size-4" strokeWidth={1.5} />
                          Switch EOA network
                        </Menu.Item>
                      ) : null}
                      <Menu.Item
                        className={walletMenuItemClassName}
                        onClick={() => {
                          void navigator.clipboard.writeText(eoaAddress).then(() => {
                            setCopiedEoa(true);
                            window.setTimeout(() => setCopiedEoa(false), 1500);
                          });
                        }}
                      >
                        {copiedEoa ? (
                          <Check aria-hidden="true" className="size-4 text-chart-3" strokeWidth={1.5} />
                        ) : (
                          <Copy aria-hidden="true" className="size-4" strokeWidth={1.5} />
                        )}
                        {copiedEoa ? "Copied EOA" : "Copy EOA address"}
                      </Menu.Item>
                    </>
                  ) : null}
                  <Menu.Item
                    className={`${walletMenuItemClassName} text-destructive data-highlighted:bg-destructive/10`}
                    onClick={() => void disconnect()}
                  >
                    <LogOut aria-hidden="true" className="size-4" strokeWidth={1.5} />
                    Log out
                  </Menu.Item>
                  {connectionError ? (
                    <p className="px-2.5 py-2 text-[11px] text-destructive">{connectionError}</p>
                  ) : null}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
        <FundingDialog
          action={fundingAction}
          address={address}
          assets={assets}
          network={config.chain.name}
          onActionChange={setFundingAction}
          onImportAsset={importAsset}
          onSelectedAssetChange={(key) => setSelectedAssetKeys((current) => ({ ...current, [config.chain.id]: key }))}
          onWithdraw={withdraw}
          selectedAssetKey={selectedAssetKey}
        />
      </>
    );
  }

  return (
    <Button
      aria-label="Connect an external EOA wallet"
      className="order-last h-8 rounded-full px-4 text-xs active:scale-[0.96]"
      disabled={!ready || connecting}
      onClick={connect}
      title="Connect external EOA wallet"
      type="button"
      variant="default"
    >
      {connecting ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
          data-icon="inline-start"
        />
      ) : (
        <Wallet aria-hidden="true" className="size-4" data-icon="inline-start" strokeWidth={2.25} />
      )}
      {connecting ? "Connecting…" : "Connect wallet"}
    </Button>
  );
}

export function WalletButton() {
  const configured = usePrivyConfigured();

  if (!configured) {
    return (
      <Button
        className="order-last h-8 rounded-full px-4 text-xs text-foreground disabled:opacity-100"
        disabled
        title="Set NEXT_PUBLIC_PRIVY_APP_ID to enable wallet connection"
        variant="outline"
      >
        Connect wallet
      </Button>
    );
  }

  return <ConnectedWalletButton />;
}
