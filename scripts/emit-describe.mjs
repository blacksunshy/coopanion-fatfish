/**
 * Regenerates describe.json from the definition the pack actually ships.
 *
 * The market reads describe.json instead of running the pack, so it has to mirror `tools()` under
 * the default config (`relayPerson` on). Bundling the TypeScript through esbuild keeps this honest
 * instead of hand-editing JSON: run `node scripts/emit-describe.mjs` after touching a tool text.
 */
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Inside the repo (not the OS temp dir): a checkout may sit somewhere the OS temp is not writable.
const cache = join('node_modules', '.cache', 'emit-describe');
mkdirSync(cache, { recursive: true });
const out = mkdtempSync(join(cache, 'run-'));
const bundle = join(out, 'definition.mjs');
try {
  await build({
    entryPoints: ['src/definition.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    logLevel: 'silent',
    // `cortico/*` is type-only in this repo (types/cortico.d.ts), so the externals never load.
    external: ['cortico', 'cortico/*', 'ws'],
  });
  const mod = await import(pathToFileURL(bundle).href);
  const describe = mod.FATFISH.describe;
  const text = `${JSON.stringify(describe, null, 2)}\n`;
  const target = 'describe.json';
  const before = readFileSync(target, 'utf8');
  if (before === text) {
    console.log('describe.json already matches the definition');
  } else {
    writeFileSync(target, text, 'utf8');
    console.log('describe.json regenerated');
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
