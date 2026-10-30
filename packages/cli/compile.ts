// Builds the standalone didpkg binaries with `bun build --compile`. Each binary has the Bun runtime in it, thus the
// user needs no Bun and no Node. Bun cross-compiles, thus 1 machine builds all targets. Writes dist-bin/: 1 archive
// didpkg-<os>-<arch>.tar.gz per target and SHA256SUMS. Each archive has 1 folder didpkg-<os>-<arch>/ with didpkg,
// LICENSE and THIRD_PARTY_LICENSES.txt. Run: bun packages/cli/compile.ts [<os>-<arch> ...]. The CI workflow
// `release` runs it, tests each binary on a native runner and, for a v* tag, makes the GitHub Release.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE, thirdPartyLicenses } from './licenses.ts';
import pkg from './package.json' with { type: 'json' };

// The x64 targets use the Bun baseline build: it also runs on x64 CPUs with no AVX2 (made before 2013).
const TARGETS = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'darwin-arm64': 'bun-darwin-arm64',
} as const;
type Name = keyof typeof TARGETS;

const BUN = `Bun ${Bun.version} (MIT)

The didpkg binary is the Bun ${Bun.version} runtime with the didpkg program in it. Bun includes JavaScriptCore and \
WebCore from WebKit (LGPL-2.0) and other libraries. The Bun license file gives each library and its license: \
https://github.com/oven-sh/bun/blob/bun-v${Bun.version}/LICENSE.md. The source code of Bun is at \
https://github.com/oven-sh/bun/tree/bun-v${Bun.version}, and the source code of its WebKit fork is at \
https://github.com/oven-sh/WebKit. The didpkg program is also the npm package didpkg (dist/cli.js), and its source \
code is at https://github.com/bnonni/didpkg. Thus you can run the didpkg program on a Bun that you build.`;

const args = process.argv.slice(2);
for (const a of args) if (!(a in TARGETS)) throw new Error(`unknown target ${a}: use ${Object.keys(TARGETS).join(', ')}`);
const names = (args.length ? args : Object.keys(TARGETS)) as Name[];

const pkgDir = fileURLToPath(new URL('.', import.meta.url));
const out = join(pkgDir, 'dist-bin');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
process.chdir(pkgDir); // the metafile paths are relative to the working folder
// The archive gives the files to uid 0, thus a tar run by root does not give the files to the uid of the build user.
const gnuTar = Bun.spawnSync(['tar', '--version']).stdout.toString().includes('GNU tar');
const owner = gnuTar ? ['--owner=0', '--group=0', '--numeric-owner'] : ['--uid', '0', '--gid', '0'];
const stage = mkdtempSync(join(tmpdir(), 'didpkg-compile-'));
const sums: string[] = [];
try {
  for (const name of names) {
    const folder = `didpkg-${name}`;
    const dir = join(stage, folder);
    mkdirSync(dir);
    const bin = join(dir, 'didpkg');
    const r = await Bun.build({ entrypoints: ['src/cli.ts'], compile: { target: TARGETS[name], outfile: bin }, minify: true, metafile: true });
    if (!r.success) throw new AggregateError(r.logs, `bun build failed for ${name}`);
    copyFileSync(join(pkgDir, '../../LICENSE'), join(dir, 'LICENSE'));
    writeFileSync(join(dir, 'THIRD_PARTY_LICENSES.txt'), `${BUN}${RULE}${thirdPartyLicenses(r.metafile!, 'The didpkg program')}`);
    // On its own platform, the binary must run and print the package version.
    if (name === `${process.platform}-${process.arch}`) {
      const v = Bun.spawnSync([bin, '--version']).stdout.toString().trim();
      if (v !== pkg.version) throw new Error(`${name}: didpkg --version printed "${v}", not ${pkg.version}`);
    }
    const archive = `${folder}.tar.gz`;
    const t = Bun.spawnSync(['tar', ...owner, '-czf', join(out, archive), '-C', stage, folder], { stderr: 'inherit' });
    if (t.exitCode !== 0) throw new Error(`tar failed for ${name}`);
    const bytes = readFileSync(join(out, archive));
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${archive}\n`);
    console.log(`${join(out, archive)} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
// The format of sha256sum and shasum -a 256: <hex>, 2 spaces, the file name.
writeFileSync(join(out, 'SHA256SUMS'), sums.join(''));
console.log(join(out, 'SHA256SUMS'));
