import type { PoolId } from "@/lib/clob";

export function missingMarketRecoveryPath({
  chainId,
  currentPoolId,
  defaultPoolId,
  errorMessage,
}: {
  chainId: number;
  currentPoolId: PoolId;
  defaultPoolId?: PoolId;
  errorMessage?: string | null;
}) {
  if (errorMessage !== `Pool ${currentPoolId} does not exist`) return null;
  if (defaultPoolId && defaultPoolId.toLowerCase() !== currentPoolId.toLowerCase()) {
    return `/${chainId}/markets/${defaultPoolId}/trade`;
  }
  return `/${chainId}/markets`;
}
