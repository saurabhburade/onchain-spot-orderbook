import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

// Run against a production server: CLOB_WEB_TEST_URL=http://localhost:3000 node --test scripts/route-loading.test.mjs
test("streams navigation feedback without waiting for market data", {
  skip: !process.env.CLOB_WEB_TEST_URL,
}, async () => {
  const started = performance.now();
  const response = await fetch(new URL("/10143/markets", process.env.CLOB_WEB_TEST_URL), {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  try {
    while (!html.includes("Loading page")) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    assert.ok(html.includes('aria-busy="true"'), "Route must stream a busy state before its data finishes");
    assert.ok(html.includes("Loading page"), "Route must stream accessible loading feedback");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `Navigation feedback took ${elapsed.toFixed(0)}ms (budget: 500ms)`);
  } finally {
    await reader.cancel();
  }
});
