// The reader entry point does not load the DWN SDK. Only the writer imports it. No source file uses a Node or Bun API.
// The registration uses only @noble/hashes.
import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import pkg from '../package.json';

const root = new URL('../', import.meta.url).pathname;

test('src: only writer.ts imports the DWN SDK; no file uses node:, Bun or process', async () => {
  const sdkUsers: string[] = [];
  const nobleUsers: string[] = [];
  const outside: string[] = [];
  for await (const file of new Glob('**/*.ts').scan(root + 'src/')) {
    const text = await Bun.file(root + 'src/' + file).text();
    if (/from\s+['"](node:|bun['"])/.test(text) || /\bBun\./.test(text) || /\bprocess\./.test(text)) outside.push(`${file}: runtime API`);
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (/^@enbox\//.test(m[1]!)) sdkUsers.push(file);
      else if (/^@noble\//.test(m[1]!)) nobleUsers.push(file);
      else if (!/^(\.|@didpkg\/core\/)/.test(m[1]!)) outside.push(`${file}: ${m[1]}`);
    }
  }
  expect([[...new Set(sdkUsers)], [...new Set(nobleUsers)].sort(), outside]).toEqual([['writer.ts'], ['registration.ts', 'writer.ts'], []]);
});

test('package.json: each entry point exists', async () => {
  expect(Object.keys(pkg.exports)).toEqual(['.', './writer', './registration', './package.json']);
  for (const target of Object.values(pkg.exports)) expect(await Bun.file(root + target).exists()).toBe(true);
  expect(await import('@didpkg/adapter-dwn').then((m) => m.DIDPKG_PROTOCOL)).toBe('https://didpkg.dev/protocols/repository/v1');
  expect(await import('@didpkg/adapter-dwn/writer').then((m) => typeof m.DwnWriter)).toBe('function');
  expect(await import('@didpkg/adapter-dwn/registration').then((m) => typeof m.register)).toBe('function');
});
