import "server-only";

import { ANVIL_CHAIN_ID, MONAD_TESTNET_CHAIN_ID } from "@/config/constants";

const localIndexerUrl = "http://localhost:8080/v1/graphql";

export function getIndexerGraphqlUrl(chainId: number) {
  if (chainId === MONAD_TESTNET_CHAIN_ID) {
    return (
      process.env.MONAD_ENVIO_GRAPHQL_URL ||
      process.env.ENVIO_GRAPHQL_URL ||
      process.env.NEXT_PUBLIC_MONAD_ENVIO_GRAPHQL_URL ||
      process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL ||
      localIndexerUrl
    );
  }
  if (chainId === ANVIL_CHAIN_ID) {
    return (
      process.env.ANVIL_ENVIO_GRAPHQL_URL ||
      process.env.ENVIO_GRAPHQL_URL ||
      process.env.NEXT_PUBLIC_ANVIL_ENVIO_GRAPHQL_URL ||
      process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL ||
      localIndexerUrl
    );
  }
  throw new Error("Unsupported CLOB chain");
}
