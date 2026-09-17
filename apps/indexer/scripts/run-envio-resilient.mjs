import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_TAIL = 64 * 1024;
const STABLE_RUN_MILLIS = 60_000;
const MAX_BACKOFF_MILLIS = 30_000;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

const retryableRpcPatterns = [
  /(?:status|http(?: status)?)\D*429\b/i,
  /\b429\s+(?:too many requests|rate limit)/i,
  /request limit reached/i,
  /rate[- ]?limit(?:ed|ing)?/i,
  /EXPONENTIAL_BACKOFF/,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/,
  /fetch failed/i,
  /socket hang up/i,
];

export function isRetryableRpcFailure(output) {
  return retryableRpcPatterns.some((pattern) => pattern.test(output));
}

function appendTail(current, chunk) {
  const combined = current + chunk;
  return combined.length > MAX_OUTPUT_TAIL ? combined.slice(-MAX_OUTPUT_TAIL) : combined;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const envioArgs = process.argv.slice(2);
  if (envioArgs.length === 0) {
    console.error("Usage: node scripts/run-envio-resilient.mjs <envio arguments>");
    process.exit(2);
  }

  let child;
  let stoppingSignal;
  let restartAttempt = 0;

  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      stoppingSignal = signal;
      if (child) {
        child.kill(signal);
      } else {
        process.exit(SIGNAL_EXIT_CODES[signal]);
      }
    });
  }

  while (!stoppingSignal) {
    const startedAt = Date.now();
    let outputTail = "";
    let spawnError;

    child = spawn("pnpm", ["exec", "envio", ...envioArgs], {
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      outputTail = appendTail(outputTail, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      outputTail = appendTail(outputTail, chunk.toString());
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    const { code, signal } = await new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    child = undefined;

    if (stoppingSignal) {
      process.exit(SIGNAL_EXIT_CODES[stoppingSignal]);
    }
    if (spawnError) {
      console.error(`[indexer] Failed to start Envio: ${spawnError.message}`);
      process.exit(1);
    }
    if (code === 0) {
      process.exit(0);
    }
    if (!isRetryableRpcFailure(outputTail)) {
      process.exit(code ?? (signal ? 1 : 0));
    }

    if (Date.now() - startedAt >= STABLE_RUN_MILLIS) {
      restartAttempt = 0;
    }
    restartAttempt += 1;
    const backoffMillis = Math.min(1_000 * 2 ** (restartAttempt - 1), MAX_BACKOFF_MILLIS);
    console.error(`[indexer] Envio exited after a transient RPC failure; restarting in ${backoffMillis}ms.`);
    await sleep(backoffMillis);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
