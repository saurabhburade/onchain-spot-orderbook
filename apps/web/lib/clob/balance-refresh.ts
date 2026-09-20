const BALANCE_REFRESH_EVENT = "clob:balances-refresh";

export function notifyBalanceRefresh() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BALANCE_REFRESH_EVENT));
}

export function subscribeToBalanceRefresh(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(BALANCE_REFRESH_EVENT, listener);
  return () => window.removeEventListener(BALANCE_REFRESH_EVENT, listener);
}
