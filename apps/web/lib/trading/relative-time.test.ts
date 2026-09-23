import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { formatTimeAgo } = require("./relative-time.ts") as typeof import("./relative-time");

test("renders current and future-skewed trade timestamps as zero seconds ago", () => {
  const nowMs = Date.UTC(2026, 8, 21, 12, 0, 0);

  assert.equal(formatTimeAgo(nowMs, nowMs), "0 seconds ago");
  assert.equal(formatTimeAgo(nowMs + 24_000, nowMs), "0 seconds ago");
});

test("renders elapsed trade time in seconds before rolling up to minutes", () => {
  const nowMs = Date.UTC(2026, 8, 21, 12, 0, 0);

  assert.equal(formatTimeAgo(nowMs - 1_000, nowMs), "1 second ago");
  assert.equal(formatTimeAgo(nowMs - 12_000, nowMs), "12 seconds ago");
  assert.equal(formatTimeAgo(nowMs - 60_000, nowMs), "1 minute ago");
});
