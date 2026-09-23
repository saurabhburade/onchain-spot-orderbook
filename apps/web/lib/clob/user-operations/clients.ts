// biome-ignore-all lint/suspicious/noExplicitAny: injected viem client methods are intentionally structural

import { type Address, createPublicClient, createWalletClient, getAddress, type Hex, isAddress } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

import {
  DIRECT_USEROP_CHAIN_ID,
  type DirectUserOperationClients,
  DirectUserOperationError,
  directChain,
  directTransport,
} from "./constants.ts";

function sponsorPrivateKey() {
  const value = process.env.SPONSER_PK;
  if (!value) throw new DirectUserOperationError("SPONSER_PK is not configured", "SPONSOR_KEY_MISSING", 503);
  const key = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DirectUserOperationError("SPONSER_PK must be a 32-byte hex private key", "SPONSOR_KEY_INVALID", 503);
  }
  return key as Hex;
}

export function createDirectUserOperationClients(): DirectUserOperationClients {
  const sponsor = privateKeyToAccount(sponsorPrivateKey(), { nonceManager });
  const chain = directChain();
  const transport = directTransport();
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account: sponsor, chain, transport }),
  };
}

export function createDirectUserOperationPublicClient() {
  return createPublicClient({ chain: directChain(), transport: directTransport() });
}

export function sponsorAddress(walletClient: any): Address {
  const address = walletClient.account?.address;
  if (!address || !isAddress(address))
    throw new DirectUserOperationError("Sponsor account is not configured", "SPONSOR_KEY_INVALID", 503);
  return getAddress(address);
}

export function sponsorChainId(walletClient: any) {
  return walletClient.chain?.id ?? DIRECT_USEROP_CHAIN_ID;
}
