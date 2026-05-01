#!/usr/bin/env node
/**
 * Bundle size checker: fails with a non-zero exit code if any distributable
 * bundle exceeds the size thresholds defined in specs/ci-package-size.
 *
 * Two metrics are checked per bundle:
 *
 *   1. Estimated code size (raw bundle minus bundled policy JSON total)
 *      Gate: CODE_SIZE_LIMIT_BYTES: guards against SDK code complexity growth.
 *      Policy data is excluded so that adding new affiliate network policies
 *      does not consume the code budget.
 *
 *   2. Gzipped total
 *      Gate: GZIP_SIZE_LIMIT_BYTES: mirrors the original standdown-sdk
 *      NFR-7 constraint; meaningful for extension ZIP and npm tarball size.
 *
 * ⚠️  The policy subtraction assumes minify: false in tsup.config.ts. If
 *     minification is ever enabled the source JSON sizes will no longer match
 *     their bundle contribution and this approximation will be inaccurate.
 *
 * Usage: node scripts/check-bundle-size.mjs
 * (Typically run via: pnpm size)
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Thresholds: adjust here when the budget changes
// ---------------------------------------------------------------------------

/** Maximum estimated SDK code size (raw bundle minus policy JSON total), per bundle. */
const CODE_SIZE_LIMIT_BYTES = 30 * 1024; // 30 KB (temporarily relaxed during refactor)

/** Maximum gzipped total bundle size, per bundle. */
const GZIP_SIZE_LIMIT_BYTES = 10 * 1024; // 10 KB

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BUNDLES = [
  resolve(ROOT, 'dist/index.mjs'),
  resolve(ROOT, 'dist/index.cjs'),
];

const POLICIES_DIR = resolve(ROOT, 'src/policies');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sum the raw byte sizes of all *.json files in the policies directory. */
function getPolicyTotalBytes() {
  const files = readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.json'));
  const total = files.reduce((sum, f) => sum + statSync(join(POLICIES_DIR, f)).size, 0);
  return { total, count: files.length };
}

/** Stream a file through gzip and return the compressed byte count. */
async function gzippedSize(filePath) {
  let total = 0;
  const counter = new Writable({
    write(chunk, _enc, cb) {
      total += chunk.length;
      cb();
    },
  });
  await pipeline(createReadStream(filePath), createGzip(), counter);
  return total;
}

/** Format bytes as a right-aligned KB string with 2 decimal places. */
function kb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

/** Return '✓' or '✗' and record a failure if the metric exceeds its limit. */
function check(label, bundle, value, limit, failures) {
  if (value > limit) {
    failures.push(
      `❌  ${bundle}  ${label}: ${kb(value)} exceeds ${kb(limit)} limit`,
    );
    return '✗';
  }
  return '✓';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { total: policyBytes, count: policyCount } = getPolicyTotalBytes();
const failures = [];

console.log('Bundle sizes\n');

for (const bundlePath of BUNDLES) {
  const rel = bundlePath.replace(ROOT + '/', '');
  const rawBytes = statSync(bundlePath).size;
  const gzBytes = await gzippedSize(bundlePath);
  const codeBytes = rawBytes - policyBytes;

  const codeStatus = check('estimated code size', rel, codeBytes, CODE_SIZE_LIMIT_BYTES, failures);
  const gzStatus = check('gzipped size', rel, gzBytes, GZIP_SIZE_LIMIT_BYTES, failures);

  console.log(`  ${rel}`);
  console.log(`    Raw total:    ${kb(rawBytes)}`);
  console.log(`    Policy data:  ${kb(policyBytes)}  (${policyCount} files)`);
  console.log(`    Code (est.):  ${kb(codeBytes)}  [limit: ${kb(CODE_SIZE_LIMIT_BYTES)}]  ${codeStatus}`);
  console.log(`    Gzipped:      ${kb(gzBytes)}  [limit: ${kb(GZIP_SIZE_LIMIT_BYTES)}]  ${gzStatus}`);
  console.log('');
}

if (failures.length > 0) {
  for (const msg of failures) {
    console.error(msg);
  }
  process.exit(1);
}

console.log('✅ All bundles within size budget');
