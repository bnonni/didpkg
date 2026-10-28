// Codec tests from didpkg@0.0.1 (test/grammar.test.ts), first from research/phase3/name-grammar/grammar.test.ts.
// Changes: validate-npm-package-name is a devDependency, one test per vector, and a golden test.
import { expect, test } from 'bun:test';
import validate from 'validate-npm-package-name';
import { format, formatDirect, parse, bindHash, didHash, GrammarError, DID_RE, MAX_NPM_NAME } from '../../src/name/grammar.ts';
import * as pkg from '../../src/name/index.ts';
import * as core from '../../src/index.ts';
import * as did from '../../src/did/index.ts';
import * as trust from '../../src/trust/index.ts';
import * as source from '../../src/source/index.ts';

const vectors: { method: string; did: string }[] = await Bun.file(new URL('./vectors.json', import.meta.url)).json();
// golden.json: format(did, name) from the research codec (research/phase3/name-grammar/grammar.ts).
const golden: { did: string; name: string; installName: string }[] = await Bun.file(new URL('./golden.json', import.meta.url)).json();

const code = (f: () => unknown) => { try { f(); return 'OK'; } catch (e) { return (e as GrammarError).code ?? String(e); } };

test('vectors.json has 28 vectors', () => {
  expect(vectors.length).toBe(28);
});

test.each(vectors.map((v) => [`${v.method} ${v.did.slice(0, 48)}`, v.did] as const))(
  'real vector %s: round trip, npm-valid for new packages, <= 214',
  (_label, did) => {
    for (const name of ['hello', 'a', 'my-lib.core', 'x'.repeat(64)]) {
      const s = format(did, name);
      expect(s.length).toBeLessThanOrEqual(MAX_NPM_NAME);
      expect(validate(s).validForNewPackages).toBe(true);
      const p = parse(s);
      if (p.form === 'direct') expect([p.did, p.name]).toEqual([did, name]);
      else expect(bindHash(p, did)).toBe(did);
    }
  },
);

test('golden: format() output is byte-for-byte the research codec output', () => {
  expect(golden.length).toBe(vectors.length * 2);
  for (const g of golden) expect(format(g.did, g.name)).toBe(g.installName);
  expect(golden.filter((g) => g.installName.includes('__')).length).toBeGreaterThan(0); // hash form is covered
});

test('name/index and the core index export the public API', () => {
  expect(Object.keys(pkg).sort()).toEqual(['GrammarError', 'bindHash', 'didHash', 'format', 'formatDirect', 'parse', 'route']);
  expect(Object.keys(core).sort()).toEqual([...Object.keys(pkg), ...Object.keys(did), ...Object.keys(trust), ...Object.keys(source)].sort());
  expect(pkg.format('did:web:nonni.org', 'hello')).toBe('@didpkg/hello_web_nonni.org');
  const e = code(() => pkg.parse('@other/x'));
  expect(e).toBe('E_SCOPE');
  try { pkg.parse('@other/x'); } catch (err) { expect(err).toBeInstanceOf(pkg.GrammarError); }
});

test('didHash: sha256 of the UTF-8 DID in lowercase base32, 52 characters', () => {
  // sha256("") = e3b0c442...b855, in RFC 4648 base32 without padding.
  expect(didHash('')).toBe('4oymiquy7qobjgx36tejs35zeqt24qpemsnzgtfeswmrw6csxbkq');
  expect(didHash('did:web:nonni.org')).toMatch(/^[a-z2-7]{52}$/);
});

test('hash form: the last character must be "a" or "q" (4 zero pad bits)', () => {
  for (const v of vectors) expect(didHash(v.did)).toMatch(/[aq]$/);
  const h51 = didHash('did:web:nonni.org').slice(0, 51);
  expect(code(() => parse(`@didpkg/hello__${h51}a`))).toBe('OK');
  expect(code(() => parse(`@didpkg/hello__${h51}q`))).toBe('OK');
  for (const last of 'bcdefghijklmnoprstuvwxyz234567') {
    expect(code(() => parse(`@didpkg/hello__${h51}${last}`))).toBe('E_HASH');
  }
});

// Random DIDs from the DID Core ABNF alphabet, biased to the hard characters.
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-';
const HEX = '0123456789abcdefABCDEF';
function randomIdchar(r: () => number): string {
  const x = r();
  if (x < 0.08) return '%' + HEX[Math.floor(r() * 22)] + HEX[Math.floor(r() * 22)];
  if (x < 0.16) return ':';
  return ALPHA[Math.floor(r() * ALPHA.length)];
}
// The fuzz tests take about 5 s each on a normal machine. bun's default limit is 5 s per test.
const FUZZ_TIMEOUT_MS = 60_000;
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000); }

test('fuzz: 200000 random ABNF DIDs round trip losslessly and canonically', () => {
  const r = rng(42);
  let direct = 0, hashed = 0;
  for (let i = 0; i < 200000; i++) {
    const method = 'abcdefghijklmnopqrstuvwxyz0123456789'.slice(0, 1 + Math.floor(r() * 36)).slice(-1 - Math.floor(r() * 6));
    let msid = '';
    const len = 1 + Math.floor(r() * 240);
    for (let k = 0; k < len; k++) msid += randomIdchar(r);
    if (msid.endsWith(':')) msid += 'x';
    const did = `did:${method}:${msid}`;
    if (!DID_RE.test(did)) continue;
    const s = format(did, 'pkg');
    expect(validate(s).validForNewPackages).toBe(true);
    const p = parse(s);
    if (p.form === 'direct') { direct++; expect(p.did).toBe(did); }
    else { hashed++; expect(bindHash(p, did)).toBe(did); }
  }
  expect(direct).toBeGreaterThan(1000);
  expect(hashed).toBeGreaterThan(1000);
}, FUZZ_TIMEOUT_MS);

test('fuzz: two different DIDs never give the same name', () => {
  const seen = new Map<string, string>();
  const r = rng(7);
  for (let i = 0; i < 100000; i++) {
    let msid = '';
    for (let k = 0; k < 1 + Math.floor(r() * 12); k++) msid += randomIdchar(r);
    if (msid.endsWith(':')) msid += 'x';
    const did = `did:web:${msid}`;
    if (!DID_RE.test(did)) continue;
    const s = format(did, 'p');
    const prev = seen.get(s);
    if (prev !== undefined) expect(prev).toBe(did);
    seen.set(s, did);
  }
}, FUZZ_TIMEOUT_MS);

test('rejections: each bad name fails with a stable code', () => {
  const dht = '@didpkg/hello_dht_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y';
  const cases: [string, string][] = [
    [dht, 'OK'],
    ['@didpkg/hello_dht.a_i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y', 'E_MASK'],     // zero mask must be omitted
    ['@didpkg/hello_web.abqa_localhost.3a8443', 'E_MASK'],                                          // trailing zero group
    ['@didpkg/hello_web.abq7_localhost.3a8443', 'E_MASK'],                                          // bits past the end
    ['@didpkg/hello_web.b_localhost.3a8443', 'OK'],                                                 // grammar OK (did:web:locaLhost.3a8443); the did:web method check rejects the uppercase host
    ['@didpkg/hello~dht~i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y', 'E_SHAPE'],         // legacy tilde
    ['@didpkg/Hello_dht_abc', 'E_NAME'],
    ['@didpkg/my_lib_dht_abc', 'OK'],                                                               // parses as name "my" and did:lib:dht:abc; the resolver rejects method lib
    ['@didpkg/hello_DHT_abc', 'E_METHOD'],
    ['@didpkg/hello_dht_', 'E_ENC_CHAR'],
    ['@didpkg/hello__abc', 'E_HASH'],
    ['@didpkg%2fhello_dht_abc', 'E_SCOPE'],
    ['@other/hello_dht_abc', 'E_SCOPE'],
    ['@didpkg/hello_web_localhost%3A8443', 'E_ENC_CHAR'],
    ['@didpkg/hello_web_a..b', 'OK'],                                                               // valid ABNF, method rules reject later
    ['@didpkg/hello_web_.%2e', 'E_ENC_CHAR'],
    ['@didpkg/' + 'h_web_' + 'a'.repeat(209), 'E_LEN'],
  ];
  const got = cases.map(([s]) => code(() => parse(s)));
  expect(got).toEqual(cases.map(([, c]) => c));
});

test('hash form: only when the direct form is too long; a wrong DID fails', () => {
  const short = 'did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y';
  const fake = `@didpkg/hello__${didHash(short)}`;
  const pf = parse(fake);
  if (pf.form !== 'hash') throw new Error(`expected hash form, got ${pf.form}`);
  expect(code(() => bindHash(pf, short))).toBe('E_HASH_BIND'); // direct form fits, so hash form is not canonical
  const long = vectors.find((v) => v.did.length > 300)!.did;
  const s = format(long, 'hello');
  const p = parse(s);
  if (p.form !== 'hash') throw new Error(`expected hash form, got ${p.form}`);
  expect(code(() => bindHash(p, long.slice(0, -1) + 'A'))).toBe('E_HASH_BIND');
  expect(bindHash(p, long)).toBe(long);
});

test('formatDirect length: did:dht with pkg-name of 64 chars', () => {
  const s = formatDirect('did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y', 'x'.repeat(64));
  expect(s.length).toBe(8 + 64 + 1 + 3 + 1 + 52);
});
