// @didpkg/core is safe in a browser. Thus src/ must not use a Node or Bun API.
import { expect, test } from 'bun:test';
import { Glob } from 'bun';

const src = new URL('../src/', import.meta.url).pathname;

test('core src imports no node: module and uses no Bun global', async () => {
  const bad: string[] = [];
  for await (const file of new Glob('**/*.ts').scan(src)) {
    const text = await Bun.file(src + file).text();
    if (/from\s+['"](node:|bun['"])/.test(text) || /\bBun\./.test(text) || /\bprocess\./.test(text)) bad.push(file);
  }
  expect(bad).toEqual([]);
});
