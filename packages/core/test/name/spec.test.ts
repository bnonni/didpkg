// The test vectors of docs/spec/install-names.md section 8 must match the codec.
import { expect, test } from 'bun:test';
import { format, parse, type GrammarError } from '../../src/name/grammar.ts';

const spec = await Bun.file(new URL('../../../../docs/spec/install-names.md', import.meta.url)).text();
const rows = (re: RegExp) => spec.split('\n').flatMap((line) => { const m = re.exec(line); return m ? [m.slice(1)] : []; });
const code = (f: () => unknown) => { try { f(); return 'OK'; } catch (e) { return (e as GrammarError).code ?? String(e); } };

const formatRows = rows(/^\| `(did:[^`]+)` \| `([^`]+)` \| `(@didpkg\/[^`]+)` \|$/);
const parseRows = rows(/^\| `([^`]+)` \| `(OK|E_[A-Z_]+)` \|/);

test('the spec has the 2 vector tables', () => {
  expect(formatRows.length).toBe(11);
  expect(parseRows.length).toBe(16);
});

test.each(formatRows)('format(%s, %s)', (did, name, installName) => {
  expect(format(did!, name!)).toBe(installName!);
  const p = parse(installName!);
  if (p.form === 'direct') expect([p.did, p.name]).toEqual([did, name]);
  else expect(installName!.length).toBe(8 + name!.length + 2 + 52);
});

test.each(parseRows)('parse(%s) gives %s', (name, result) => {
  expect(code(() => parse(name!))).toBe(result!);
});

test('the worked example of section 3', () => {
  expect(spec).toContain('The install name is `@didpkg/hello_web.aam_example.com.3a3000_user_alice`.');
  expect(format('did:web:example.com%3A3000:user:alice', 'hello')).toBe('@didpkg/hello_web.aam_example.com.3a3000_user_alice');
});
