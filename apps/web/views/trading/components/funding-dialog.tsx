"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Check, ChevronDown, Copy, LoaderCircle, Plus, Search, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { type Address, isAddress } from "viem";

import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sanitizeDecimalInput } from "@/lib/utils";

export type FundingAction = "deposit" | "withdraw";

export type WalletAsset = {
  address?: Address;
  balance: string;
  balanceRaw: bigint | null;
  decimals: number;
  iconUrl?: string;
  key: string;
  name: string;
  symbol: string;
};

export type FundingDialogProps = {
  action: FundingAction | null;
  address?: string;
  assets: WalletAsset[];
  network: string;
  onActionChange: (action: FundingAction | null) => void;
  onImportAsset: (address: Address) => Promise<WalletAsset>;
  onSelectedAssetChange: (key: string) => void;
  onWithdraw: (recipient: string, amount: string, asset: WalletAsset) => Promise<void>;
  selectedAssetKey: string;
};

function messageFrom(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Wallet transaction failed. Please try again.";
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function AssetMark({ asset, compact = false }: { asset: WalletAsset; compact?: boolean }) {
  return (
    <TokenIcon
      className={`bg-muted ${compact ? "size-5" : "size-10"}`}
      fallbackClassName={compact ? "size-3" : "size-5"}
      sizes={compact ? "20px" : "40px"}
      url={asset.iconUrl}
    />
  );
}

function TokenSelector({
  assets,
  onImportAsset,
  onOpenChange,
  onSelect,
  open,
  selectedAssetKey,
}: {
  assets: WalletAsset[];
  onImportAsset: (address: Address) => Promise<WalletAsset>;
  onOpenChange: (open: boolean) => void;
  onSelect: (asset: WalletAsset) => void;
  open: boolean;
  selectedAssetKey: string;
}) {
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAssets = assets.filter(
    (asset) =>
      !normalizedQuery ||
      asset.symbol.toLowerCase().includes(normalizedQuery) ||
      asset.name.toLowerCase().includes(normalizedQuery) ||
      asset.address?.toLowerCase().includes(normalizedQuery),
  );
  const pastedAddress = isAddress(query.trim()) ? (query.trim() as Address) : null;
  const addressAlreadyListed = pastedAddress
    ? assets.some((asset) => asset.address?.toLowerCase() === pastedAddress.toLowerCase())
    : false;

  function setOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setImportError(null);
      setImporting(false);
    }
  }

  async function importToken() {
    if (!pastedAddress || importing) return;
    setImportError(null);
    setImporting(true);
    try {
      const asset = await onImportAsset(pastedAddress);
      onSelect(asset);
      setOpen(false);
    } catch (error) {
      setImportError(messageFrom(error));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto p-4">
          <Dialog.Popup className="flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <Dialog.Title className="sr-only">Select withdrawal asset</Dialog.Title>
            <Dialog.Description className="sr-only">
              Search wallet assets or paste an ERC-20 contract address to import a token.
            </Dialog.Description>
            <div className="flex items-center gap-2 border-b border-border p-3">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <Input
                  aria-label="Search tokens or paste address"
                  autoComplete="off"
                  autoFocus
                  className="h-11 rounded-full bg-muted pr-4 pl-9 text-sm"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setImportError(null);
                  }}
                  placeholder="Search tokens or paste address"
                  spellCheck={false}
                  value={query}
                />
              </div>
              <Dialog.Close
                aria-label="Close token selector"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground outline-none transition-[color,background-color,transform] hover:bg-muted/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96]"
              >
                <X aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </Dialog.Close>
            </div>

            {!normalizedQuery ? (
              <div className="border-b border-border px-4 py-3">
                <p className="mb-2 text-xs text-muted-foreground">Popular</p>
                <div className="flex flex-wrap gap-2">
                  {assets.slice(0, 3).map((asset) => (
                    <button
                      className="inline-flex h-9 items-center gap-2 rounded-full bg-muted px-3 text-xs font-semibold outline-none transition-[background-color,transform] hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96]"
                      key={asset.key}
                      onClick={() => {
                        onSelect(asset);
                        setOpen(false);
                      }}
                      type="button"
                    >
                      <AssetMark asset={asset} compact />
                      {asset.symbol}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filteredAssets.map((asset) => {
                const selected = asset.key === selectedAssetKey;
                return (
                  <button
                    aria-pressed={selected}
                    className="flex min-h-16 w-full items-center gap-3 rounded-xl px-3 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30"
                    key={asset.key}
                    onClick={() => {
                      onSelect(asset);
                      setOpen(false);
                    }}
                    type="button"
                  >
                    <AssetMark asset={asset} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{asset.symbol}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{asset.name}</span>
                    </span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{asset.balance}</span>
                    <Check
                      aria-hidden="true"
                      className={`size-4 shrink-0 transition-opacity ${selected ? "opacity-100" : "opacity-0"}`}
                      strokeWidth={2}
                    />
                  </button>
                );
              })}

              {pastedAddress && !addressAlreadyListed ? (
                <button
                  className="flex min-h-16 w-full items-center gap-3 rounded-xl px-3 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
                  disabled={importing}
                  onClick={() => void importToken()}
                  type="button"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted">
                    {importing ? (
                      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Plus aria-hidden="true" className="size-4" strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">
                      {importing ? "Importing token…" : "Import token"}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {shortenAddress(pastedAddress)}
                    </span>
                  </span>
                </button>
              ) : null}

              {!filteredAssets.length && !pastedAddress ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {normalizedQuery.startsWith("0x") ? "Paste a valid token address to import it." : "No tokens found."}
                </p>
              ) : null}
              {importError ? (
                <p className="m-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                  {importError}
                </p>
              ) : null}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function FundingDialog({
  action,
  address,
  assets,
  network,
  onActionChange,
  onImportAsset,
  onSelectedAssetChange,
  onWithdraw,
  selectedAssetKey,
}: FundingDialogProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [assetSelectorOpen, setAssetSelectorOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastAction = useRef<FundingAction>("deposit");
  if (action) lastAction.current = action;
  const displayedAction = action ?? lastAction.current;
  const nativeAsset = assets.find((asset) => asset.key === "native") ?? assets[0];
  const selectedAsset = assets.find((asset) => asset.key === selectedAssetKey) ?? nativeAsset;

  function closeDialog() {
    if (withdrawing) return;
    onActionChange(null);
  }

  function resetDialogState() {
    setRecipient("");
    setAmount("");
    setAssetSelectorOpen(false);
    setCopied(false);
    setError(null);
  }

  function selectAsset(asset: WalletAsset) {
    onSelectedAssetChange(asset.key);
    setAmount("");
    setError(null);
  }

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setError("Could not copy the address. Select and copy it manually.");
    }
  }

  async function submitWithdraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRecipient = recipient.trim();
    const nextAmount = amount.trim();
    if (!nextRecipient || !nextAmount || !selectedAsset || withdrawing) return;

    setError(null);
    setWithdrawing(true);
    try {
      await onWithdraw(nextRecipient, nextAmount, selectedAsset);
      onActionChange(null);
    } catch (nextError) {
      setError(messageFrom(nextError));
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <>
      <Dialog.Root
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) resetDialogState();
        }}
        open={action !== null}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
            <Dialog.Popup className="relative w-full max-w-sm rounded-2xl border border-border bg-popover p-5 text-popover-foreground outline-none transition-[scale,opacity] duration-150 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.96] data-starting-style:opacity-0">
              <Dialog.Title className="pr-10 text-base font-semibold">
                {displayedAction === "deposit" ? "Deposit asset" : "Withdraw asset"}
              </Dialog.Title>
              <Dialog.Description
                className={
                  displayedAction === "deposit"
                    ? "sr-only"
                    : "mt-1 text-pretty text-xs leading-relaxed text-muted-foreground"
                }
              >
                {displayedAction === "deposit"
                  ? `Send ${nativeAsset?.symbol ?? "funds"} on ${network} to your embedded wallet address.`
                  : `Send ${selectedAsset?.symbol ?? "an asset"} from your embedded wallet to another address on ${network}.`}
              </Dialog.Description>
              <Dialog.Close
                aria-label={`Close ${displayedAction} dialog`}
                className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-[color,background-color,transform] hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
                disabled={withdrawing}
              >
                <X aria-hidden="true" className="size-4" strokeWidth={2} />
              </Dialog.Close>

              {displayedAction === "deposit" ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-xl border border-border bg-background p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Wallet address</p>
                    <p className="mt-2 break-all font-mono text-xs leading-relaxed text-foreground">{address ?? "—"}</p>
                  </div>
                  {error ? (
                    <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <Dialog.Close className="inline-flex h-10 items-center justify-center rounded-full bg-secondary px-4 text-xs font-medium text-secondary-foreground outline-none transition-[background-color,transform] hover:bg-secondary/70 focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96]">
                      Done
                    </Dialog.Close>
                    <Button
                      className="h-10 rounded-full text-xs active:scale-[0.96]"
                      disabled={!address}
                      onClick={() => void copyAddress()}
                      type="button"
                    >
                      {copied ? (
                        <Check aria-hidden="true" className="size-4" />
                      ) : (
                        <Copy aria-hidden="true" className="size-4" />
                      )}
                      {copied ? "Copied" : "Copy address"}
                    </Button>
                  </div>
                </div>
              ) : (
                <form className="mt-5 space-y-4" onSubmit={(event) => void submitWithdraw(event)}>
                  <label className="block space-y-1.5" htmlFor="withdraw-recipient">
                    <span className="text-xs font-medium">Recipient address</span>
                    <Input
                      autoComplete="off"
                      autoFocus
                      className="h-11 rounded-xl bg-background px-3 font-mono text-xs"
                      disabled={withdrawing}
                      id="withdraw-recipient"
                      onChange={(event) => setRecipient(event.target.value)}
                      placeholder="0x…"
                      spellCheck={false}
                      value={recipient}
                    />
                  </label>
                  <div className="space-y-1.5">
                    <span className="flex items-center justify-between gap-3 text-xs">
                      <label className="font-medium" htmlFor="withdraw-amount">
                        Amount
                      </label>
                      <span className="text-muted-foreground">
                        Available:{" "}
                        <span className="font-mono tabular-nums text-foreground">
                          {selectedAsset?.balance ?? "—"} {selectedAsset?.symbol ?? ""}
                        </span>
                      </span>
                    </span>
                    <span className="relative block">
                      <Input
                        autoComplete="off"
                        autoCorrect="off"
                        className="h-11 rounded-xl bg-background px-3 pr-28 font-mono tabular-nums"
                        disabled={withdrawing}
                        id="withdraw-amount"
                        inputMode="decimal"
                        onChange={(event) => setAmount(sanitizeDecimalInput(event.target.value))}
                        placeholder="0.00"
                        spellCheck={false}
                        value={amount}
                      />
                      <button
                        aria-expanded={assetSelectorOpen}
                        aria-haspopup="dialog"
                        aria-label={`Select withdrawal asset. Current asset: ${selectedAsset?.symbol ?? "none"}`}
                        className="absolute inset-y-1 right-1 inline-flex min-w-20 items-center justify-end gap-1 rounded-lg px-2 font-mono text-[11px] text-muted-foreground outline-none transition-[color,background-color,transform] hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96]"
                        disabled={withdrawing}
                        onClick={() => setAssetSelectorOpen(true)}
                        role="combobox"
                        type="button"
                      >
                        {selectedAsset?.symbol ?? "Select"}
                        <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
                      </button>
                    </span>
                  </div>
                  {error ? (
                    <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <Dialog.Close
                      className="inline-flex h-10 items-center justify-center rounded-full bg-secondary px-4 text-xs font-medium text-secondary-foreground outline-none transition-[background-color,transform] hover:bg-secondary/70 focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
                      disabled={withdrawing}
                    >
                      Cancel
                    </Dialog.Close>
                    <Button
                      className="h-10 rounded-full text-xs active:scale-[0.96]"
                      disabled={!recipient.trim() || !amount.trim() || !selectedAsset || withdrawing}
                      type="submit"
                    >
                      {withdrawing ? "Withdrawing…" : "Withdraw"}
                    </Button>
                  </div>
                </form>
              )}
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>

      <TokenSelector
        assets={assets}
        onImportAsset={onImportAsset}
        onOpenChange={setAssetSelectorOpen}
        onSelect={selectAsset}
        open={assetSelectorOpen}
        selectedAssetKey={selectedAssetKey}
      />
    </>
  );
}
