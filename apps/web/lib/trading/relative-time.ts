const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

export function formatTimeAgo(timestampMs: number, nowMs: number) {
  const elapsedSeconds = Math.max(0, Math.round((nowMs - timestampMs) / 1_000));

  if (elapsedSeconds < 60) return relativeTimeFormatter.format(-elapsedSeconds, "second");
  if (elapsedSeconds < 3_600) return relativeTimeFormatter.format(-Math.round(elapsedSeconds / 60), "minute");
  if (elapsedSeconds < 86_400) return relativeTimeFormatter.format(-Math.round(elapsedSeconds / 3_600), "hour");
  if (elapsedSeconds < 2_592_000) return relativeTimeFormatter.format(-Math.round(elapsedSeconds / 86_400), "day");
  if (elapsedSeconds < 31_536_000)
    return relativeTimeFormatter.format(-Math.round(elapsedSeconds / 2_592_000), "month");
  return relativeTimeFormatter.format(-Math.round(elapsedSeconds / 31_536_000), "year");
}
