import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, markdownAnchors, slug } from '../check.ts';

// The parts are split, so that the link check of this repo does not read these URLs as links.
const REPO = 'https://github.com/bnonni/didpkg/' + 'blob/main/';
const fence = '```';

describe('slug', () => {
  test.each([
    ['1. Install the CLI', '1-install-the-cli'],
    ['`didpkg id register`', 'didpkg-id-register'],
    ['did:web', 'didweb'],
    ['Lockfiles and CI', 'lockfiles-and-ci'],
    ['See [ADR 0003](adr/0003.md) now', 'see-adr-0003-now'],
    ['hello_web and Déjà vu', 'hello_web-and-déjà-vu'],
  ])('%s', (heading, expected) => expect(slug(heading)).toBe(expected));
});

describe('markdownAnchors', () => {
  test('gives -1 to a repeated heading, ignores a heading in a fence, and adds HTML ids', () => {
    const text = ['# Title', '## Errors', `${fence}sh`, '# not a heading', fence, '## Errors ##', '<a id="pins"></a>'].join('\n');
    expect([...markdownAnchors(text)]).toEqual(['title', 'errors', 'errors-1', 'pins']);
  });
});

describe('check', () => {
  const root = mkdtempSync(join(tmpdir(), 'didpkg-links-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('gives 1 line for each link with no target, and none for a good link', () => {
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'site', 'proto'), { recursive: true });
    writeFileSync(join(root, 'docs', 'b.md'), '# B\n\n## Good part\n');
    writeFileSync(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'site', 'proto', 'v1'), '{}\n');
    writeFileSync(
      join(root, 'docs', 'a.md'),
      [
        '# A',
        '[ok](b.md) [ok](b.md#good-part) [ok](#a) [ok](../src/x.ts) [ok](/docs/b.md)',
        '[bad](missing.md) [bad](b.md#nope) [bad](#none)',
        '`[code](ignored.md)` [web](https://example.com/none.md)',
        `${fence}md`,
        '[fence](ignored.md)',
        fence,
        `See ${REPO}docs/b.md#good-part. And ${REPO}docs/gone.md.`,
      ].join('\n'),
    );
    writeFileSync(join(root, 'src', 'cli.ts'), `const a = '${REPO}docs/b.md';\nconst b = '${REPO}src/x.ts#L1';\nconst c = '${REPO}docs/b.md#bad';\n`);
    writeFileSync(
      join(root, 'site', 'index.html'),
      '<p id="install"><a href="#install">ok</a> <a href="proto/v1">ok</a> <a href="/proto/v1">ok</a> <a href="./">ok</a> <a href="#gone">bad</a> <link href="style.css"></p>',
    );
    const files = ['docs/a.md', 'src/cli.ts', 'site/index.html'].map((f) => join(root, f));
    const { links, problems } = check(root, files, join(root, 'site'));
    expect(problems).toEqual([
      'docs/a.md: no file: missing.md',
      'docs/a.md: no anchor: b.md#nope',
      'docs/a.md: no anchor: #none',
      `docs/a.md: no file: ${REPO}docs/gone.md`,
      `src/cli.ts: no anchor: ${REPO}docs/b.md#bad`,
      'site/index.html: no anchor: #gone',
      'site/index.html: no file: style.css',
    ]);
    expect(links).toBe(19);
  });
});
