// Interop with the Rust reference tool of Gordian Envelope (`envelope`, bc-envelope-cli 0.35.0). The Rust tool reads
// the XID document, a release record and the SSKR shares that didpkg makes with the TypeScript libraries.
// The test needs Docker and the image of the tool. If the image is absent, the test skips. Build the image:
// docker build -t didpkg-envelope-cli:0.35.0 packages/cli/test/interop
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublicKeys } from '@blockchaincommons/components';
import { Envelope } from '@blockchaincommons/envelope';
import { sskrJoin } from '@blockchaincommons/envelope/sskr';
import { UR } from '@blockchaincommons/uniform-resources';
import { Key } from '@blockchaincommons/xid';
import { signXidRelease, xidContentDigest, xidFromUr } from '@didpkg/core/xid';
import { idPaths } from '../src/id/store.ts';
import { backupXid, createXid, openXidKey, readXidIdentity, xidUr } from '../src/id/xid.ts';

const IMAGE = 'didpkg-envelope-cli:0.35.0';
const hasImage = Bun.which('docker') !== null
  && Bun.spawnSync(['docker', 'image', 'inspect', IMAGE], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

const tmp = mkdtempSync(join(tmpdir(), 'didpkg-interop-xid-'));
const env = { DIDPKG_HOME: tmp };
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The `toUR()` of PublicKeys needs the global tag names. A test does not change global state.
const pubUr = (k: PublicKeys) => UR.from('crypto-pubkeys', k.untaggedCbor()).toString();

/** Run the Rust tool. Each argument is a word: no shell. */
function rust(...args: string[]) {
  const r = Bun.spawnSync(['docker', 'run', '--rm', IMAGE, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function ok(...args: string[]): string {
  const r = rust(...args);
  if (r.code !== 0) throw new Error(`envelope ${args[0]}: exit ${r.code}: ${r.err}`);
  return r.out;
}

/** A XID identity and a signed release. Each key open costs one Argon2id run, thus the setup runs only with the image. */
async function setup() {
  await createXid({ alias: 'ix', dwn: 'https://dwn.example', repos: ['https://pkgs.example.com/x/'], passphrase: PASS, updatePassphrase: UPDATE_PASS, env });
  const paths = idPaths('ix', env);
  const { identity, info } = readXidIdentity(paths);
  const releaseKey = openXidKey(identity, 'release', PASS);
  const dwnKey = openXidKey(identity, 'dwn', PASS);
  const tarball = new TextEncoder().encode('a tarball');
  const release = await signXidRelease({ publisher: info.xid, name: 'hello', version: '1.0.0', tarball, npm: { dependencies: {} }, head: null, published: '2026-11-04T12:00:00.000Z' }, [releaseKey]);
  return { paths, info, releaseKey, dwnKey, release, releaseUr: release.envelope.toUR().toString() };
}

describe.skipIf(!hasImage)('Gordian interop with the Rust envelope tool', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup(); });

  test('verifies the release signature with the release key, and refuses another key', () => {
    expect(rust('verify', '--silent', '--verifier', pubUr(s.releaseKey.publicKeys()), s.releaseUr).code).toBe(0);
    const other = rust('verify', '--silent', '--verifier', pubUr(s.dwnKey.publicKeys()), s.releaseUr);
    expect(other.code).not.toBe(0);
  });

  test('gives the same envelope digest and the same content digest as didpkg', () => {
    expect(ok('digest', '--hex', s.releaseUr)).toBe(s.release.envelope.digest().toHex());
    const subject = UR.parse(ok('extract', 'wrapped', s.releaseUr));
    expect(`sha256-${Envelope.fromUntaggedCbor(subject.cbor).digest().toBase64()}`).toBe(xidContentDigest(s.release));
  });

  test('reads the XID document: the XID with the inception signature, and the public keys', () => {
    const docUr = Envelope.fromBytes(readFileSync(s.paths.xidDocument)).toUR().toString();
    // The `hex` form of the Rust tool 0.35.0 gives the short form `XID(<8 hex>)`. Thus the test reads the full `ur:xid`.
    const id = ok('xid', 'id', '--verify', 'inception', '--format', 'ur', docUr);
    expect(id).toBe(xidUr(s.info.document));
    expect(xidFromUr(id)).toBe(s.info.xid);
    const keys = ok('xid', 'key', 'all', '--verify', 'inception', docUr).split('\n');
    // Each key is an envelope: the public keys and the permissions. The bytes must be the same as didpkg makes.
    expect(keys.sort()).toEqual(s.info.keys.map((k) => k.key.toEnvelope().toUR().toString()).sort());
    const key = keys.map((k) => Key.fromEnvelope(Envelope.fromUntaggedCbor(UR.parse(k).cbor))).find((k) => pubUr(k.publicKeys) === pubUr(s.releaseKey.publicKeys()));
    expect([...key!.permissions.allow]).toEqual(['Sign']);
  });

  test('joins 2 of the 3 backup shares to the same backup envelope as didpkg', () => {
    const { shares } = backupXid({ alias: 'ix', sskr: '2-of-3', passphrase: PASS, updatePassphrase: UPDATE_PASS, env });
    const joined = ok('sskr', 'join', shares[2]!, shares[0]!);
    const ours = sskrJoin([shares[0]!, shares[1]!].map((t) => Envelope.fromUntaggedCbor(UR.parse(t).cbor)));
    // The TypeScript join gives the wrapped backup, as didpkg splits it. The Rust tool gives the backup.
    expect(joined).toBe(ours.unwrap().toUR().toString());
    expect(rust('sskr', 'join', shares[1]!).code).not.toBe(0);
  });
});
