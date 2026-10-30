// The install check against the live demo DWN and the live mirrors. User B has no keys.
// B starts `didpkg shim start` with the default public Pkarr relays. Then npm, pnpm and bun install each name
// with a cold cache, and Node loads it. Run it with the DWN up, then stop the DWN (docs/deploy.md) and run it
// again with --dwn-down: the installs then come from the mirrors.
// Usage, from the repo root: npm run live -- [--dwn-down] <install-name>...
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DWN = 'https://dwn.didpkg.dev';
const EXPECTED = 'hello from didpkg';
const cli = fileURLToPath(new URL('../packages/cli/src/cli.ts', import.meta.url));
const args = process.argv.slice(2);
const dwnDown = args.includes('--dwn-down');
const names = args.filter((a) => a !== '--dwn-down');
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-live-'));
const t0 = performance.now();
let stopShim = async () => {};

/** Throws on a non-zero exit. */
async function run(cmd: string[], cwd: string, home: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { PATH: process.env.PATH!, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} (exit ${code})\n${(err || out).trim()}`);
  return out;
}

async function step(name: string, fn: () => Promise<unknown>) {
  const t = performance.now();
  await fn();
  console.log(`ok   ${name} (${Math.round(performance.now() - t)} ms)`);
}

/** A new HOME for each install, thus each package manager starts with a cold cache and no user config. */
function newHome(name: string): string {
  const home = join(tmp, name);
  mkdirSync(home);
  return home;
}

/** Installs the package in a new app with a cold cache, then Node loads it. */
async function install(home: string, shimUrl: string, cmd: string[]) {
  const app = join(home, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }));
  writeFileSync(join(app, '.npmrc'), `@didpkg:registry=${shimUrl}/\n`);
  await run(cmd, app, home);
  const loaded = (await run(['node', '-p', `require(${JSON.stringify(cmd.at(-1))})`], app, home)).trim();
  if (loaded !== EXPECTED) throw new Error(`node loaded ${JSON.stringify(loaded)}, expected ${JSON.stringify(EXPECTED)}`);
}

try {
  if (names.length === 0) throw new Error('usage: npm run live -- [--dwn-down] <install-name>...');
  await step(`${DWN}/health ${dwnDown ? 'fails' : 'is ok'}`, async () => {
    const up = await fetch(`${DWN}/health`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
    if (up === dwnDown) throw new Error(dwnDown ? 'the DWN is up: stop it first' : 'the DWN is down');
  });

  const home = newHome('home-b');
  const log = join(home, 'shim.log');
  const shimUrl = await (async () => {
    const p = Bun.spawn([process.execPath, cli, 'shim', 'start', '--port', '0'], {
      env: { PATH: process.env.PATH!, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: Bun.file(log),
    });
    stopShim = async () => {
      p.kill('SIGTERM');
      await p.exited;
    };
    const first = await p.stdout.getReader().read();
    if (!first.value) throw new Error(`the shim did not start: ${readFileSync(log, 'utf8').trim()}`);
    return (JSON.parse(new TextDecoder().decode(first.value)) as { url: string }).url;
  })();
  console.log(`     shim ${shimUrl} (default relays)`);

  const npmFlags = ['--no-audit', '--no-fund', '--no-update-notifier', '--fetch-retries', '0'];
  for (const [i, name] of names.entries()) {
    console.log(`     ${name}`);
    await step('npm install, then Node loads it', () => install(newHome(`npm-${i}`), shimUrl, ['npm', 'install', ...npmFlags, name]));
    await step('pnpm add, then Node loads it', () => install(newHome(`pnpm-${i}`), shimUrl, ['pnpm', 'add', name]));
    await step('bun add, then Node loads it', () => install(newHome(`bun-${i}`), shimUrl, [process.execPath, 'add', name]));
  }
  console.log(`PASS (${Math.round(performance.now() - t0)} ms)`);
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await stopShim().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
