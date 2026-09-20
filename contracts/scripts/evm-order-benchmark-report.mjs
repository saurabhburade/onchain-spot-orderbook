#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(SCRIPT_DIR, "..");
const FORGE_ARGS = ["test", "--match-path", "test/EVMOrderActionBenchmark.t.sol", "-vv"];
const GAS_PRICE_GWEI = 102n;
const REFERENCE_FEE_NANO_MON = 3_016_344n;
const REFERENCE_USD_MICRO = 76n;
// biome-ignore lint/complexity/useRegexLiterals: constructor avoids treating the ANSI escape byte as a literal control character
const ANSI_ESCAPE = new RegExp("\\x1B\\[[0-?]*[ -/]*[@-~]", "g");
const FIELD_ORDER = ["benchmark", "book orders", "price levels", "matches", "gas used", "gas per match"];
const FIELD_INDEX = new Map(FIELD_ORDER.map((field, index) => [field, index]));
const EXPECTED_SCENARIO_ORDER = [
  "create-limit-new-price-level",
  "create-limit-existing-price-level",
  "cancel-single-order",
  "single-limit-fill",
  "market-fill-100-single-price-level",
  "market-fill-50-dense-1000-level-book",
  "market-fill-100-dense-1000-level-book",
  "market-fill-200-dense-1000-level-book",
];
const SCENARIO_INDEX = new Map(EXPECTED_SCENARIO_ORDER.map((name, index) => [name, index]));
const SCENARIO_LABELS = new Map([
  ["create-limit-new-price-level", "Create limit — new price level"],
  ["create-limit-existing-price-level", "Create limit — existing price level"],
  ["cancel-single-order", "Cancel one resting order"],
  ["single-limit-fill", "Fill one resting order (limit)"],
  ["market-fill-100-single-price-level", "Market fill — 100 matches (1 price level)"],
  ["market-fill-50-dense-1000-level-book", "Market fill — 50 matches (dense book)"],
  ["market-fill-100-dense-1000-level-book", "Market fill — 100 matches (dense book)"],
  ["market-fill-200-dense-1000-level-book", "Market fill — 200 matches (dense book)"],
]);

function parseInteger(value, field, benchmark) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Malformed ${field} for ${JSON.stringify(benchmark)}: expected a non-negative integer`);
  }
  return BigInt(value);
}

function validateRecord(record) {
  const expectedGasPerMatch = record.matches === 0n ? 0n : record.gasUsed / record.matches;
  if (record.gasPerMatch !== expectedGasPerMatch) {
    throw new Error(
      `Malformed gas per match for ${JSON.stringify(record.benchmark)}: ` +
        `expected ${expectedGasPerMatch}, got ${record.gasPerMatch}`,
    );
  }
}

/**
 * Parse Forge's named-log records. Other Forge output is ignored, but every
 * recognized field must form a complete record in the documented field order.
 */
export function parseRecords(output) {
  const rows = [];
  const seenBenchmarks = new Set();
  let record = null;
  let nextField = 0;

  for (const rawLine of output.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const separator = rawLine.indexOf(":");
    if (separator < 0) continue;

    const field = rawLine.slice(0, separator).trim().toLowerCase();
    const value = rawLine.slice(separator + 1).trim();
    const fieldIndex = FIELD_INDEX.get(field);
    if (fieldIndex === undefined) continue;

    if (field === "benchmark") {
      if (record !== null) {
        throw new Error(`Missing ${FIELD_ORDER.slice(nextField).join(", ")} before the next benchmark`);
      }
      if (value.length === 0) throw new Error("Malformed benchmark: value is empty");
      record = { benchmark: value };
      nextField = 1;
      continue;
    }

    if (record === null) {
      throw new Error(`Found ${field} before a benchmark record`);
    }
    if (fieldIndex !== nextField) {
      throw new Error(
        `Malformed record for ${JSON.stringify(record.benchmark)}: ` +
          `expected ${FIELD_ORDER[nextField]}, got ${field}`,
      );
    }

    const parsed = parseInteger(value, field, record.benchmark);
    if (field === "book orders") record.bookOrders = parsed;
    if (field === "price levels") record.priceLevels = parsed;
    if (field === "matches") record.matches = parsed;
    if (field === "gas used") record.gasUsed = parsed;
    if (field === "gas per match") record.gasPerMatch = parsed;
    nextField += 1;

    if (nextField === FIELD_ORDER.length) {
      validateRecord(record);
      const key = record.benchmark;
      if (!SCENARIO_INDEX.has(key)) {
        throw new Error(`Unexpected benchmark row: ${JSON.stringify(record.benchmark)}`);
      }
      if (seenBenchmarks.has(key)) {
        throw new Error(`Duplicate benchmark row: ${JSON.stringify(record.benchmark)}`);
      }
      seenBenchmarks.add(key);
      rows.push(record);
      record = null;
      nextField = 0;
    }
  }

  if (record !== null) {
    throw new Error(`Missing ${FIELD_ORDER.slice(nextField).join(", ")} for ${JSON.stringify(record.benchmark)}`);
  }
  if (rows.length === 0) throw new Error("Forge output contained no benchmark rows");
  const missing = EXPECTED_SCENARIO_ORDER.filter((name) => !seenBenchmarks.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing expected benchmark rows: ${missing.join(", ")}`);
  }
  return rows;
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    return SCENARIO_INDEX.get(left.benchmark) - SCENARIO_INDEX.get(right.benchmark);
  });
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatFixed(value, decimals) {
  const digits = value.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function feeNanoMon(gasUsed) {
  return gasUsed * GAS_PRICE_GWEI;
}

function formatMonadFee(gasUsed) {
  return formatFixed(feeNanoMon(gasUsed), 9);
}

function formatUsdFee(gasUsed) {
  const numerator = feeNanoMon(gasUsed) * REFERENCE_USD_MICRO;
  const usdMicro = (numerator + REFERENCE_FEE_NANO_MON / 2n) / REFERENCE_FEE_NANO_MON;
  return `$${formatFixed(usdMicro, 6)}`;
}

function escapeMarkdown(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatReport(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Cannot format an empty benchmark report");
  }

  const sortedRows = sortRows(rows);
  const lines = [
    "# EVM Order Action Gas Benchmark",
    "",
    "Book orders before and Price levels before describe the pre-action fixture state; fixture seeding is excluded from the reported gas.",
    "Fee assumptions: Monad gas price 102 Gwei (0.000000102 MON per gas); USD values use the provided reference 0.003016344 MON = $0.000076.",
    "",
    "| Action | Book orders before | Price levels before | Matches | Total gas | Gas / match | Fee (MON) | Fee (USD) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const row of sortedRows) {
    lines.push(
      `| ${escapeMarkdown(SCENARIO_LABELS.get(row.benchmark))} | ${formatInteger(row.bookOrders)} | ` +
        `${formatInteger(row.priceLevels)} | ${formatInteger(row.matches)} | ` +
        `${formatInteger(row.gasUsed)} | ${row.matches === 0n ? "—" : formatInteger(row.gasPerMatch)} | ` +
        `${formatMonadFee(row.gasUsed)} | ${formatUsdFee(row.gasUsed)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const SAMPLE_ROWS = [
  ["create-limit-new-price-level", 0, 0, 0, 120000, 0],
  ["create-limit-existing-price-level", 1, 1, 0, 110000, 0],
  ["cancel-single-order", 1, 1, 0, 50000, 0],
  ["single-limit-fill", 1, 1, 1, 90000, 90000],
  ["market-fill-100-single-price-level", 100, 1, 100, 1500000, 15000],
  ["market-fill-50-dense-1000-level-book", 1000, 50, 50, 1234567, 24691],
  ["market-fill-100-dense-1000-level-book", 1000, 100, 100, 2000000, 20000],
  ["market-fill-200-dense-1000-level-book", 1000, 200, 200, 3000000, 15000],
];

function sampleRecord([benchmark, bookOrders, priceLevels, matches, gasUsed, gasPerMatch]) {
  return `  benchmark: ${benchmark}
  book orders: ${bookOrders}
  price levels: ${priceLevels}
  matches: ${matches}
  gas used: ${gasUsed}
  gas per match: ${gasPerMatch}`;
}

function sampleOutput(rows = SAMPLE_ROWS) {
  return `
[PASS] testBenchmark (gas: 123)
${[...rows].reverse().map(sampleRecord).join("\n")}
`;
}

function runSelfTest() {
  const rows = parseRecords(sampleOutput());
  assert.equal(rows.length, EXPECTED_SCENARIO_ORDER.length);
  const report = formatReport(rows);
  assert.ok(report.includes("Book orders before | Price levels before"));
  assert.ok(report.includes("pre-action fixture state; fixture seeding is excluded from the reported gas."));
  assert.ok(report.includes("Monad gas price 102 Gwei"));
  assert.equal(formatMonadFee(29_572n), "0.003016344");
  assert.equal(formatUsdFee(29_572n), "$0.000076");
  assert.equal(escapeMarkdown("a | b"), "a \\| b");
  const reportPositions = EXPECTED_SCENARIO_ORDER.map((name) => report.indexOf(`| ${SCENARIO_LABELS.get(name)} |`));
  assert.ok(reportPositions.every((position) => position >= 0));
  assert.ok(reportPositions.every((position, index) => index === 0 || position > reportPositions[index - 1]));
  assert.ok(report.includes("| Create limit — new price level | 0 | 0 | 0 | 120,000 | — |"));
  assert.ok(report.includes("| Market fill — 50 matches (dense book) | 1,000 | 50 | 50 | 1,234,567 | 24,691 |"));

  assert.throws(
    () => parseRecords(sampleOutput().replace("gas per match: 0", "gas per match: nope")),
    /Malformed gas per match/,
  );
  assert.throws(() => parseRecords(sampleOutput([...SAMPLE_ROWS, SAMPLE_ROWS[0]])), /Duplicate benchmark row/);
  assert.throws(
    () => parseRecords(sampleOutput(SAMPLE_ROWS.filter(([name]) => name !== "market-fill-100-dense-1000-level-book"))),
    /Missing expected benchmark rows: market-fill-100-dense-1000-level-book/,
  );
  assert.throws(
    () => parseRecords(sampleOutput([...SAMPLE_ROWS, ["unexpected-scenario", 0, 0, 0, 1, 0]])),
    /Unexpected benchmark row: "unexpected-scenario"/,
  );
  assert.throws(() => parseRecords(sampleOutput().replace("price levels: 0\n", "")), /expected price levels/);
  console.log("evm-order-benchmark-report self-test: ok");
}

function runForge() {
  const result = spawnSync("forge", FORGE_ARGS, {
    cwd: CONTRACTS_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      RUN_LARGE_BENCHMARKS: process.env.RUN_LARGE_BENCHMARKS ?? "true",
    },
    shell: false,
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) {
    throw new Error(`Unable to execute Forge: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Forge benchmark failed with exit code ${result.status}\n${output.trim()}`);
  }
  process.stdout.write(formatReport(parseRecords(output)));
}

if (process.argv[2] === "--self-test") {
  runSelfTest();
} else if (process.argv.length !== 2) {
  console.error("Usage: node scripts/evm-order-benchmark-report.mjs [--self-test]");
  process.exitCode = 2;
} else {
  try {
    runForge();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
