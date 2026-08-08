/* global URL, process */

import { access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const outputFile = new URL('../dist/app.js', import.meta.url);
const outputPath = fileURLToPath(outputFile);
const entryPoint = fileURLToPath(new URL('../src/app.ts', import.meta.url));

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: 'cjs',
  outfile: outputPath,
  platform: 'node',
  target: 'node22'
});

await access(outputFile, constants.R_OK);
const syntaxCheck = spawnSync(process.execPath, ['--check', outputPath], { stdio: 'inherit' });
if (syntaxCheck.status !== 0) {
  process.exit(syntaxCheck.status ?? 1);
}
