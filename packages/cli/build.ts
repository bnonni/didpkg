// Builds dist/, the files of the npm package: cli.js (1 file for Node, with all dependencies in it), LICENSE,
// and THIRD_PARTY_LICENSES.txt (the license of each bundled package). Run in packages/cli: npm run build.
// src/cli.ts keeps the bun shebang for a run from the repo.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyLicenses } from './licenses.ts';

const pkgDir = fileURLToPath(new URL('.', import.meta.url));
const dist = join(pkgDir, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
process.chdir(pkgDir); // the metafile paths are relative to the working folder
const r = await Bun.build({ entrypoints: ['src/cli.ts'], target: 'node', outdir: dist, metafile: true });
if (!r.success) throw new AggregateError(r.logs, 'bun build failed');

// Bun copies the source shebang. npm runs the bin with the shebang, so it must name node.
const cli = join(dist, 'cli.js');
const lines = readFileSync(cli, 'utf8').split('\n').filter((l, i) => !(i < 2 && (l.startsWith('#!') || l === '// @bun')));
writeFileSync(cli, ['#!/usr/bin/env node', ...lines].join('\n'), { mode: 0o755 });
copyFileSync(join(pkgDir, '../../LICENSE'), join(dist, 'LICENSE'));
const notice = thirdPartyLicenses(r.metafile!, 'dist/cli.js');
writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), notice);
console.log(`${cli} (${(Bun.file(cli).size / 1e6).toFixed(1)} MB), ${notice.split('\n', 1)[0]}`);
