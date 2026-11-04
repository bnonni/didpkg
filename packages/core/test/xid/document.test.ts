import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { checkProvenance, grants, keysWith, readXidDocument, xidFromUr, XidError, type XidErrorCode } from '../../src/xid/index.ts';
import { docBytes, GENESIS_DATE, publisherDoc, strayMark, toHex } from './fixture.ts';
import golden from './golden.json';

// BCR-2024-010 section "Uniform Resources": a bare XID and a XID document for the same XID.
const SPEC_XID = '71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c';
const SPEC_BARE = 'ur:xid/hdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnvsbyrdfw';
const SPEC_DOC =
  'ur:xid/tpsplstpsotanshdhdcxjsdigtwneocmnybadpdlzobysbstmekteypspeotcfldynlpsfolsbintyjkrhfnoyastpsotpcxksceisjyjyjojkftdldljpihjkjljzkoihjpdmihkshsjnjojzihdmiajljnoyastpsotpcxjnidjyiajpftdyeheyeoeeecenemmtcwrogm';

function code(f: () => unknown): XidErrorCode | string {
  try {
    f();
  } catch (e) {
    return e instanceof XidError ? e.code : `not a XidError: ${String(e)}`;
  }
  return 'no error';
}

describe('golden XID document', () => {
  test('fixed seeds give the same bytes on each run', () => {
    expect(toHex(docBytes())).toBe(golden.genesis);
    expect(toHex(sha256(docBytes({ seq: 2 })))).toBe(golden.seq2Sha256);
    expect(publisherDoc().xid.toHex()).toBe(golden.xid);
  });

  test('read gives the keys, the service, dereferenceVia and the provenance mark', () => {
    const info = readXidDocument(Buffer.from(golden.genesis, 'hex'), golden.xid);
    expect(info.xid).toBe(golden.xid);
    const keys = info.keys.map((k) => [k.nickname, k.allow, k.deny, k.inception]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(keys).toEqual([
      ['', ['All'], [], true],
      ['dwn', ['Auth'], [], false],
      ['release', ['Sign'], [], false],
    ]);
    const dwn = info.keys.find((k) => k.nickname === 'dwn')!;
    expect(dwn.reference).toMatch(/^[0-9a-f]{64}$/);
    expect(info.services).toEqual([{ uri: 'https://dwn.example', capability: 'dwn', name: '', keyReferences: [dwn.reference], allow: ['Auth'], deny: [] }]);
    expect(info.dereferenceVia).toEqual([`https://mirror.example/xid/${golden.xid}.envelope`]);
    expect([info.provenance.seq, info.provenance.date, info.provenance.mark.isGenesis]).toEqual([0, GENESIS_DATE.toISOString(), true]);
    expect(info.provenance.chainId).toMatch(/^[0-9a-f]+$/);
  });

  test('keysWith follows the deny-first permissions', () => {
    const info = readXidDocument(docBytes());
    expect(keysWith(info, 'Sign').map((k) => k.nickname).sort()).toEqual(['', 'release']);
    expect(keysWith(info, 'Auth').map((k) => k.nickname).sort()).toEqual(['', 'dwn']);
    expect(keysWith(info, 'Update').map((k) => k.inception)).toEqual([true]);
  });
});

describe('grants', () => {
  test.each([
    ['allow Sign', ['Sign'], [], true],
    ['allow All', ['All'], [], true],
    ['allow All, deny Sign', ['All'], ['Sign'], false],
    ['allow Sign, deny All (deny overrides allow)', ['Sign'], ['All'], false],
    ['allow Auth', ['Auth'], [], false],
    ['no allow', [], [], false],
  ] as const)('%s', (_l, allow, deny, want) => {
    expect(grants({ allow: [...allow], deny: [...deny] }, 'Sign')).toBe(want);
  });
});

describe('readXidDocument refuses', () => {
  test.each([
    ['an unsigned document', () => readXidDocument(docBytes({ sign: false })), 'XID_INVALID'],
    ['a changed byte', () => { const b = docBytes(); b[b.length - 5]! ^= 1; return readXidDocument(b); }, 'XID_INVALID'],
    ['bytes that are not CBOR', () => readXidDocument(new Uint8Array([1, 2, 3])), 'XID_INVALID'],
    ['the document of another XID', () => readXidDocument(docBytes({ inception: 7 }), golden.xid), 'XID_MISMATCH'],
    ['a document with no provenance mark', () => readXidDocument(docBytes({ provenance: false })), 'XID_NO_PROVENANCE'],
  ] as const)('%s', (_l, f, want) => {
    expect(code(f)).toBe(want);
  });
});

describe('checkProvenance', () => {
  const at = (o: Parameters<typeof docBytes>[0]) => readXidDocument(docBytes(o)).provenance;
  test.each([
    ['the same mark', {}, {}, 'no error'],
    ['the next mark', {}, { seq: 1 }, 'no error'],
    ['a gap in seq', {}, { seq: 3 }, 'no error'],
    ['a lower seq', { seq: 2 }, { seq: 1 }, 'XID_ROLLBACK'],
    ['another chain id', {}, { seq: 1, chain: 5 }, 'XID_CHAIN'],
    ['another mark with the same seq', { seq: 1 }, { seq: 1, date: new Date('2027-01-01T00:00:00Z') }, 'XID_FORK'],
    ['a next mark that is not in the chain', {}, { seq: 1, mark: strayMark }, 'XID_FORK'],
  ] as const)('%s', (_l, known, next, want) => {
    expect(code(() => checkProvenance(at(known), at(next)))).toBe(want);
  });
});

describe('xidFromUr', () => {
  test('the spec vectors: a bare XID and a XID document', () => {
    expect(xidFromUr(SPEC_BARE)).toBe(SPEC_XID);
    expect(xidFromUr(SPEC_DOC)).toBe(SPEC_XID);
    expect(xidFromUr(SPEC_BARE.toUpperCase())).toBe(SPEC_XID);
  });

  test.each([
    ['another UR type', SPEC_BARE.replace('ur:xid/', 'ur:seed/')],
    ['a bad checksum', SPEC_BARE.slice(0, -2) + 'aa'],
    ['not a UR', SPEC_XID],
  ])('refuses %s', (_l, s) => {
    expect(code(() => xidFromUr(s))).toBe('XID_INVALID');
  });
});
