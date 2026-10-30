// Router tests for the didpkg npm shim.
import { expect, test } from 'bun:test';
import { route } from '../../src/name/route.ts';
import { format } from '../../src/name/grammar.ts';

const vectors: { method: string; did: string }[] = await Bun.file(new URL('./vectors.json', import.meta.url)).json();

test('every canonical name routes the same for npm (%2f), pnpm (%2F), bun (%2f) and plain "/"', () => {
  for (const v of vectors) {
    for (const pkg of ['hello', 'a.b-c', 'x'.repeat(64)]) {
      const name = format(v.did, pkg);
      const body = name.split('/')[1];
      for (const p of [`/@didpkg%2f${body}`, `/@didpkg%2F${body}`, `/@didpkg/${body}`, `/@didpkg%2f${body}?write=true`]) {
        const r = route('GET', p);
        expect(r.kind).toBe('packument');
        if (r.kind === 'packument') {
          expect(r.name).toBe(name);
          if (r.parsed.form === 'direct') expect(r.parsed.did).toBe(v.did);
        }
      }
      const t = route('GET', `/@didpkg/${body}/-/${body}-1.2.3-beta.1+b7.tgz?did=x`);
      expect(t.kind).toBe('tarball');
      if (t.kind === 'tarball') expect(t.version).toBe('1.2.3-beta.1+b7');
      expect(route('PUT', `/@didpkg%2f${body}`).kind).toBe('publish');
    }
  }
});

test('the drpm.tools misparse cannot happen: legacy and hostile paths are rejected', () => {
  const dht = 'i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y';
  const cases: [string, string, string][] = [
    ['GET', '/@didpkg%2freact~web~nonni.org', 'reject'],             // legacy "~method~": no guessing
    ['GET', '/@drpm%2freact~web~nonni.org', 'reject'],               // other scope
    ['GET', `/@didpkg%252fhello_dht_${dht}`, 'reject'],              // double encoding
    ['GET', `/@didpkg%2fhello_dht_${dht}%2f..`, 'reject'],
    ['GET', `/@didpkg%2f..%2fhello_dht_${dht}`, 'reject'],
    ['GET', '/@didpkg%2fhello_web_localhost%253A8443', 'reject'],
    ['GET', '/@didpkg%2fhello_web_localhost%3A8443', 'reject'],     // raw percent in the body
    ['GET', `/@didpkg%2fHello_dht_${dht}`, 'reject'],                // uppercase
    ['GET', `/@didpkg%2fhello_dht.a_${dht}`, 'reject'],              // non-canonical mask
    ['GET', `/@didpkg/hello_dht_${dht}/-/other_dht_${dht}-1.0.0.tgz`, 'reject'], // file for another name
    ['GET', `/@didpkg/hello_dht_${dht}/-/hello_dht_${dht}-latest.tgz`, 'reject'],
    ['DELETE', `/@didpkg%2fhello_dht_${dht}`, 'reject'],
    ['GET', `/@didpkg%2fhello_dht_${dht}`, 'packument'],
  ];
  const got = cases.map(([m, p]) => route(m, p));
  expect(got.map((r): string => r.kind)).toEqual(cases.map((c) => c[2]));
});

// Regression test for the drpm.tools route bug.
// drpm.tools registered '/:scope/:name~:id' and '/:scope/:name~:method~:id' after decodeURIComponent(req.url).
// Express 4.21.2 and 5.3.0 gave 200 and built did:dht:nonni.org for the "~web~" paths below.
// route() must reject each path and must never return a DID for it.
test('the Express misparse cannot come back', () => {
  const bodies = [
    'hello~8w7ckznnw671az7nmkrd19ddctpj4spgt8sjqxkmnamdartxh1bo',
    'react~web~nonni.org',
    'my~lib~web~nonni.org',
  ];
  const paths: string[] = [];
  for (const scope of ['@drpm', '@didpkg']) {
    for (const b of bodies) paths.push(`/${scope}%2f${b}`, `/${scope}%2F${b}`, `/${scope}/${b}`, `/${scope}%252f${b}`);
  }
  for (const p of paths) {
    const r = route('GET', p);
    expect(r.kind).toBe('reject');
    expect('parsed' in r).toBe(false);
  }
});
