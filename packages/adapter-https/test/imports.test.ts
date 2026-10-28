// The reader entry point is safe in a browser. Only the dir: writer uses a Node API.
import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import pkg from '../package.json';

const root = new URL('../', import.meta.url).pathname;

test('src: only dir.ts uses node:, and each import is relative, node: or @didpkg/core', async () => {
  const nodeUsers: string[] = [];
  const outside: string[] = [];
  for await (const file of new Glob('**/*.ts').scan(root + 'src/')) {
    const text = await Bun.file(root + 'src/' + file).text();
    if (/from\s+['"](node:|bun['"])/.test(text) || /\bBun\./.test(text) || /\bprocess\./.test(text)) nodeUsers.push(file);
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (!/^(\.|node:|@didpkg\/core\/)/.test(m[1]!)) outside.push(`${file}: ${m[1]}`);
    }
  }
  expect([nodeUsers, outside]).toEqual([['dir.ts'], []]);
});

test('package.json: each entry point exists', async () => {
  expect(Object.keys(pkg.exports)).toEqual(['.', './dir', './package.json']);
  for (const target of Object.values(pkg.exports)) expect(await Bun.file(root + target).exists()).toBe(true);
  expect(await import('@didpkg/adapter-https').then((m) => typeof m.httpsAdapter)).toBe('function');
  expect(await import('@didpkg/adapter-https/dir').then((m) => typeof m.DirWriter)).toBe('function');
});
