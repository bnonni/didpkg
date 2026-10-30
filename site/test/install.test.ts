// The install script (site/public/install) with a fake release on a local HTTP server.
// The fake didpkg is a shell script. The release workflow tests the script with the real binaries on Linux and macOS.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'public', 'install');
const VERSION = '9.8.7';
const os = { linux: 'linux', darwin: 'darwin' }[process.platform as string];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch as string];
const name = `didpkg-${os}-${arch}`;
const asset = `${name}.tar.gz`;

/** Runs the install script with sh, or with bash that reads it on stdin (as in curl ... | bash). */
async function install(env: Record<string, string>, shell: 'sh' | 'bash' = 'sh') {
  const proc = Bun.spawn(shell === 'sh' ? ['sh', SCRIPT] : ['bash'], {
    env: { PATH: process.env.PATH!, ...env },
    stdin: shell === 'sh' ? 'ignore' : Bun.file(SCRIPT),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe.skipIf(!os || !arch)('install script', () => {
  const root = mkdtempSync(join(tmpdir(), 'didpkg-install-'));
  const www = join(root, 'www');
  let server: ReturnType<typeof Bun.serve>;
  let url = '';
  let n = 0;
  /** A new HOME and install folder for each run. */
  const fresh = () => {
    const home = join(root, `home-${++n}`);
    mkdirSync(home);
    return { home, dir: join(home, 'didpkg') };
  };

  beforeAll(async () => {
    // A release folder: the archive with 1 folder in it, and SHA256SUMS.
    const stage = join(root, 'stage', name);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'didpkg'), `#!/bin/sh\necho ${VERSION}\n`);
    chmodSync(join(stage, 'didpkg'), 0o755);
    writeFileSync(join(stage, 'LICENSE'), 'license\n');
    writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'), 'notices\n');
    const rel = join(www, 'rel');
    mkdirSync(rel, { recursive: true });
    const tar = Bun.spawn(['tar', '-czf', join(rel, asset), '-C', join(root, 'stage'), name]);
    expect(await tar.exited).toBe(0);
    const hash = new Bun.CryptoHasher('sha256').update(readFileSync(join(rel, asset))).digest('hex');
    writeFileSync(join(rel, 'SHA256SUMS'), `${'0'.repeat(64)}  didpkg-other-cpu.tar.gz\n${hash}  ${asset}\n`);
    // bad: 1 more byte in the archive. noline: no SHA256SUMS line for this archive.
    cpSync(rel, join(www, 'bad'), { recursive: true });
    appendFileSync(join(www, 'bad', asset), 'x');
    cpSync(rel, join(www, 'noline'), { recursive: true });
    writeFileSync(join(www, 'noline', 'SHA256SUMS'), `${hash}  didpkg-other-cpu.tar.gz\n`);

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const file = join(www, new URL(req.url).pathname);
        return file.startsWith(www) && existsSync(file) ? new Response(Bun.file(file)) : new Response('Not Found', { status: 404 });
      },
    });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('installs the binary and the license files, and prints the PATH line', async () => {
    const { home, dir } = fresh();
    const r = await install({ HOME: home, DIDPKG_INSTALL: dir, DIDPKG_DOWNLOAD_URL: `${url}/rel/` });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Source: ${url}/rel/${asset}`);
    expect(r.stdout).toContain('SHA-256 OK: ');
    expect(r.stdout).toContain(`Installed didpkg ${VERSION} in ${dir}/bin/didpkg`);
    expect(r.stdout).toContain(`  export PATH="${dir}/bin:$PATH"`);
    expect(Bun.spawnSync([join(dir, 'bin', 'didpkg'), '--version']).stdout.toString()).toBe(`${VERSION}\n`);
    expect(readFileSync(join(dir, 'LICENSE'), 'utf8')).toBe('license\n');
    expect(existsSync(join(dir, 'THIRD_PARTY_LICENSES.txt'))).toBe(true);
  });

  test('bash on stdin installs to ~/.didpkg, and a second run replaces the binary', async () => {
    const { home } = fresh();
    const bin = join(home, '.didpkg', 'bin');
    const env = { HOME: home, DIDPKG_DOWNLOAD_URL: `${url}/rel`, DIDPKG_VERSION: `v${VERSION}`, PATH: `${bin}:${process.env.PATH}` };
    expect((await install(env, 'bash')).code).toBe(0);
    const r = await install(env, 'bash');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Installed didpkg ${VERSION} in ${bin}/didpkg`);
    expect(r.stdout).toContain('Run: didpkg --help');
    expect(r.stdout).not.toContain('not on your PATH');
    expect(r.stdout).not.toContain('Warning');
  });

  test('a fish user gets the fish_add_path line', async () => {
    const { home, dir } = fresh();
    const r = await install({ HOME: home, DIDPKG_INSTALL: dir, DIDPKG_DOWNLOAD_URL: `${url}/rel`, SHELL: '/usr/bin/fish' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`  fish_add_path "${dir}/bin"`);
  });

  test.each([
    ['a bad SHA-256', 'bad', {}, `didpkg install: error: the SHA-256 of ${asset} is `],
    ['no SHA256SUMS line', 'noline', {}, `didpkg install: error: SHA256SUMS has no line for ${asset}`],
    ['a 404', 'missing', {}, `didpkg install: error: cannot download `],
    ['another version', 'rel', { DIDPKG_VERSION: '1.0.0' }, `didpkg install: error: the binary is version ${VERSION}, not 1.0.0.`],
    ['a bad version', 'rel', { DIDPKG_VERSION: '1.0/../x' }, 'didpkg install: error: DIDPKG_VERSION is not a version: 1.0/../x'],
  ])('%s stops the install and changes nothing', async (_, folder, env, error) => {
    const { home, dir } = fresh();
    const r = await install({ HOME: home, DIDPKG_INSTALL: dir, DIDPKG_DOWNLOAD_URL: `${url}/${folder}`, ...env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(error);
    expect(r.stdout).not.toContain('Installed');
    expect(existsSync(dir)).toBe(false);
  });
});
