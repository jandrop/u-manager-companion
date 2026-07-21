#!/usr/bin/env node
/**
 * Size-budget gate for the SEA binary.
 *
 * Numeric go/no-go: binary size > 150 MB triggers the Bun-fallback
 * evaluation. This script only checks the on-disk size of the produced
 * artifact -- idle RSS is a live-box measurement, not something a
 * build-time script can observe.
 *
 * Threshold is intentionally a local constant so a breach is a loud,
 * obvious failure in CI/local output rather than a silent drift.
 */
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, '..');

// Bytes, not MiB-approximated -- 150 MB is the stated budget.
const MAX_BYTES = 150 * 1024 * 1024;

const target = process.argv[2] ?? path.join(serviceRoot, 'dist', 'u-manager-companion-service-linux-x64');

if (!existsSync(target)) {
  console.error(`check-size-budget: no artifact found at ${target}`);
  console.error('Run npm run sea first to produce the SEA binary.');
  process.exit(1);
}

const { size } = statSync(target);
const sizeMb = (size / (1024 * 1024)).toFixed(1);
const budgetMb = (MAX_BYTES / (1024 * 1024)).toFixed(0);

if (size > MAX_BYTES) {
  console.error(
    `check-size-budget: FAIL -- ${target} is ${sizeMb} MB, exceeds the ${budgetMb} MB budget.`,
  );
  console.error('This crosses the Bun-fallback trigger -- flag for follow-up evaluation.');
  process.exit(1);
}

console.log(`check-size-budget: OK -- ${target} is ${sizeMb} MB (budget ${budgetMb} MB).`);
