export const marketsPerPage = 10;

export function getMarketPage<T>(items: T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / marketsPerPage));
  const currentPage = Math.min(Math.max(1, Math.trunc(requestedPage)), pageCount);
  const startIndex = (currentPage - 1) * marketsPerPage;

  return {
    currentPage,
    items: items.slice(startIndex, startIndex + marketsPerPage),
    pageCount,
    startIndex,
  };
}
