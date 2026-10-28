// Builds dist/, the files of the npm package: cli.js (1 file for Node, with all dependencies in it), LICENSE,
// and THIRD_PARTY_LICENSES.txt (the license of each bundled package). Run in packages/cli: bun run build.
// src/cli.ts keeps the bun shebang for a run from the repo.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// One section per bundled package version, with its license files. If the npm package has no license file,
// the section has the license field, the author and the repository of its package.json.
const roots = new Set<string>();
for (const input of Object.keys(r.metafile!.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) roots.add(resolve(m[1]!));
}
const sections = [...roots].map((root) => {
  const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string; version: string; license?: string; author?: string | { name?: string }; repository?: string | { url?: string };
  };
  const files = readdirSync(root).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f)).sort();
  const author = typeof p.author === 'string' ? p.author : p.author?.name;
  const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url;
  const texts = files.length
    ? files.map((f) => readFileSync(join(root, f), 'utf8').trim())
    : [`The npm package has no license file. Author: ${author || 'not given'}. Repository: ${repo ?? 'not given'}.`];
  return { id: `${p.name}@${p.version}`, text: [`${p.name}@${p.version} (${p.license ?? 'no license field'})`, ...texts].join('\n\n') };
}).sort((a, b) => a.id.localeCompare(b.id));
const rule = `\n\n${'-'.repeat(80)}\n\n`;
writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), `dist/cli.js includes these ${sections.length} packages.${rule}${sections.map((s) => s.text).join(rule)}\n`);
console.log(`${cli} (${(Bun.file(cli).size / 1e6).toFixed(1)} MB), ${sections.length} bundled packages`);
