#!/usr/bin/env node
// Enforces the bundle-size budgets from issue #23: the eagerly-loaded entry chunk must stay
// under 300 kB gzipped, and the whole JS+CSS bundle (every chunk `rollup-plugin-visualizer`
// reports — lazy route chunks included, static assets like fonts excluded, since those are
// never bundled through Rollup) under 1 MB gzipped. Both are overridable via env vars so the
// numbers can be retuned without touching this file (the issue itself says "adjust after the
// first measurement").
//
// Reads two files `pnpm build` produces (see `vite.config.ts`):
//   - dist/.vite/manifest.json  — Vite's manifest; `index.html`'s entry names the entry chunk file.
//   - dist/bundle-stats.json    — rollup-plugin-visualizer's `raw-data` report: a `tree` of chunk
//     nodes down to per-module leaves, and a `nodeParts` map from leaf `uid` to
//     `{renderedLength, gzipLength}`. A chunk's total gzip size is the sum of its leaves' sizes
//     (gzip doesn't distribute linearly over concatenation, so this is an approximation — always
//     an overestimate relative to the real, single-stream gzip of the whole chunk file, which
//     keeps the check conservative rather than blind to growth).

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST_DIR = path.resolve(import.meta.dirname, '../dist');
const MAIN_CHUNK_BUDGET_BYTES = Number(process.env.BUNDLE_MAIN_CHUNK_BUDGET_KB ?? 300) * 1024;
const TOTAL_BUDGET_BYTES = Number(process.env.BUNDLE_TOTAL_BUDGET_KB ?? 1024) * 1024;

function sumLeafGzip(node, nodeParts) {
  if (node.uid !== undefined) {
    return nodeParts[node.uid]?.gzipLength ?? 0;
  }
  return (node.children ?? []).reduce((total, child) => total + sumLeafGzip(child, nodeParts), 0);
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(DIST_DIR, '.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find((entryValue) => entryValue.isEntry);
  if (!entry) {
    throw new Error('No entry chunk found in dist/.vite/manifest.json');
  }

  const stats = JSON.parse(await readFile(path.join(DIST_DIR, 'bundle-stats.json'), 'utf8'));
  const chunks = stats.tree.children.map((node) => ({
    name: node.name,
    gzipBytes: sumLeafGzip(node, stats.nodeParts),
  }));

  const mainChunk = chunks.find((chunk) => chunk.name === entry.file);
  if (!mainChunk) {
    throw new Error(`Entry chunk ${entry.file} not found in dist/bundle-stats.json`);
  }

  // `rollup-plugin-visualizer` only tracks JS modules that go through Rollup's module graph -
  // Tailwind's CSS output is emitted as a separate asset and never shows up in `stats.tree`, so
  // it's measured directly here (real single-stream gzip, not the leaf-sum approximation above).
  const assetsDir = path.join(DIST_DIR, 'assets');
  const cssFiles = (await readdir(assetsDir)).filter((file) => file.endsWith('.css'));
  const cssChunks = await Promise.all(
    cssFiles.map(async (file) => ({
      name: `assets/${file}`,
      gzipBytes: gzipSync(await readFile(path.join(assetsDir, file))).byteLength,
    })),
  );

  const allChunks = [...chunks, ...cssChunks];
  const totalBytes = allChunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);

  console.log('Bundle budget report');
  console.log('---------------------');
  for (const chunk of [...allChunks].sort((a, b) => b.gzipBytes - a.gzipBytes)) {
    const marker = chunk.name === entry.file ? ' (entry)' : '';
    console.log(`${formatKb(chunk.gzipBytes).padStart(10)}  ${chunk.name}${marker}`);
  }
  console.log('---------------------');
  console.log(
    `Entry chunk: ${formatKb(mainChunk.gzipBytes)} (budget ${formatKb(MAIN_CHUNK_BUDGET_BYTES)})`,
  );
  console.log(`Total:       ${formatKb(totalBytes)} (budget ${formatKb(TOTAL_BUDGET_BYTES)})`);

  const failures = [];
  if (mainChunk.gzipBytes > MAIN_CHUNK_BUDGET_BYTES) {
    failures.push(
      `entry chunk ${formatKb(mainChunk.gzipBytes)} exceeds budget ${formatKb(MAIN_CHUNK_BUDGET_BYTES)}`,
    );
  }
  if (totalBytes > TOTAL_BUDGET_BYTES) {
    failures.push(`total ${formatKb(totalBytes)} exceeds budget ${formatKb(TOTAL_BUDGET_BYTES)}`);
  }

  if (failures.length > 0) {
    console.error(`\nBundle budget exceeded: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

await main();
