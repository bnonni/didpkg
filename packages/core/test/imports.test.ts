// @didpkg/core is safe in a browser. Thus src/ must not use a Node or Bun API.
import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import pkg from '../package.json';

const root = new URL('../', import.meta.url).pathname;
const src = root + 'src/';

async function sources(): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const file of new Glob('**/*.ts').scan(src)) out.push([file, await Bun.file(src + file).text()]);
  return out;
}

test('core src imports no node: module and uses no Bun global', async () => {
  const bad: string[] = [];
  for (const [file, text] of await sources()) {
    if (/from\s+['"](node:|bun['"])/.test(text) || /\bBun\./.test(text) || /\bprocess\./.test(text)) bad.push(file);
  }
  expect(bad).toEqual([]);
});

// PLAN.md "Rules" item 1: only did/drivers/*.ts import a DID method library, one file per library.
test('import borders: each DID library has one importer', async () => {
  const importers: Record<string, string[]> = {};
  for (const [file, text] of await sources()) {
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      (importers[name] ??= []).push(file);
    }
  }
  for (const files of Object.values(importers)) files.sort();
  expect(importers).toEqual({
    '@noble/hashes': ['name/grammar.ts'],
    '@scure/base': ['did/drivers/jwk.ts', 'did/drivers/key.ts'],
    '@enbox/dids': ['did/drivers/dht.ts'],
    'web-did-resolver': ['did/drivers/web.ts'],
  });
});

test('dependencies have exact versions', () => {
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    expect([name, /^\d+\.\d+\.\d+$/.test(version)]).toEqual([name, true]);
  }
});

// Phase 1 exit criterion 4: a test imports every entry point and proves no network call and no process exit.
test('every entry point imports with no network call and no process exit', () => {
  const entries = Object.entries(pkg.exports).filter(([k]) => k !== './package.json').map(([, v]) => root + v);
  const script = `
    const events = [];
    globalThis.fetch = async (u) => { events.push('fetch ' + u); throw new Error('network at import'); };
    globalThis.WebSocket = class { constructor(u) { events.push('websocket ' + u); } };
    process.exit = (c) => { events.push('exit ' + c); };
    process.reallyExit = (c) => { events.push('reallyExit ' + c); };
    for (const e of ${JSON.stringify(entries)}) await import(e);
    await new Promise((r) => setTimeout(r, 50));
    console.log(JSON.stringify(events));
  `;
  const run = Bun.spawnSync([process.execPath, '-e', script], { cwd: root });
  expect(run.stderr.toString()).toBe('');
  expect([run.exitCode, JSON.parse(run.stdout.toString().trim())]).toEqual([0, []]);
});
