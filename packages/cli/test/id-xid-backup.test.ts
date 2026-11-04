// `didpkg id backup --sskr` and `didpkg id restore` for a XID publisher (Gordian Envelope SSKR).
// Each lock and each open of a key costs one Argon2id run (about 0.5 s). Thus the tests share one backup.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UR } from '@blockchaincommons/uniform-resources';
import { checkProvenance, readXidDocument } from '@didpkg/core/xid';
import { idPaths } from '../src/id/store.ts';
import { backupXid, createXid, openXidKey, readXidIdentity, restoreXid, updateXid } from '../src/id/xid.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-xid-backup-'));
const home = (name: string) => ({ DIDPKG_HOME: join(tmp, name) });
const env = home('a');
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';
const NEW_PASS = 'release passphrase 2';
const NEW_UPDATE_PASS = 'update passphrase 2';
const DATE = new Date('2026-11-04T12:00:00Z');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const seedOf = (k: ReturnType<typeof openXidKey>) => hex(k.signingPrivateKey.asEd25519()!.bytes);
const publicOf = (k: ReturnType<typeof openXidKey>) => hex(k.publicKeys().toCbor().toData());

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], extra: Record<string, string>) {
  const r = Bun.spawnSync([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH!, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe('id backup --sskr and id restore', async () => {
  await createXid({ alias: 'bx', dwn: 'https://dwn.example', repos: ['https://pkgs.example.com/x/'], passphrase: PASS, updatePassphrase: UPDATE_PASS, env, date: DATE });
  await updateXid({ alias: 'bx', rotate: ['release'], passphrase: async () => PASS, updatePassphrase: UPDATE_PASS, env, date: DATE });
  const paths = idPaths('bx', env);
  const { identity, info } = readXidIdentity(paths);
  const backup = backupXid({ alias: 'bx', sskr: '2-of-3', passphrase: PASS, updatePassphrase: UPDATE_PASS, env });

  test('gives n shares as ur:envelope, and no share holds a private key in the clear', () => {
    expect(backup).toMatchObject({ alias: 'bx', xid: info.xid, seq: 1, sskr: '2-of-3' });
    expect(backup.shares).toHaveLength(3);
    const seeds = (['release', 'dwn', 'previousRelease'] as const).map((r) => seedOf(openXidKey(identity, r, PASS)));
    for (const s of backup.shares) {
      expect(s).toStartWith('ur:envelope/');
      const body = hex(UR.parse(s).cbor.toData());
      for (const seed of seeds) expect(body).not.toContain(seed);
    }
  });

  test('2 of the 3 shares restore the same document and the same keys, locked with the new passphrases', async () => {
    const env2 = home('b');
    const r = restoreXid({ alias: 'bx', shares: [backup.shares[2]!, backup.shares[0]!], passphrase: NEW_PASS, updatePassphrase: NEW_UPDATE_PASS, env: env2 });
    expect(r).toMatchObject({ alias: 'bx', xid: info.xid, seq: 1 });
    const paths2 = idPaths('bx', env2);
    expect(readFileSync(paths2.xidDocument)).toEqual(readFileSync(paths.xidDocument));
    const restored = readXidIdentity(paths2).identity;
    expect(restored.created).toBe(identity.created);
    for (const role of ['release', 'dwn', 'previousRelease'] as const) {
      expect(publicOf(openXidKey(restored, role, NEW_PASS))).toBe(publicOf(openXidKey(identity, role, PASS)));
    }
    expect(() => openXidKey(restored, 'release', PASS)).toThrow('wrong passphrase');
    // The restored generator continues the chain: the next document gets the next provenance mark.
    const next = await updateXid({ alias: 'bx', repos: ['https://pkgs.example.com/y/'], updatePassphrase: NEW_UPDATE_PASS, env: env2, date: DATE });
    expect(next.seq).toBe(2);
    const doc2 = readXidDocument(readFileSync(paths2.xidDocument), info.xid);
    expect(() => checkProvenance(info.provenance, doc2.provenance)).not.toThrow();
  });

  test('refuses one share, shares of 2 backups, a text that is not a share, and an alias with files', () => {
    const other = backupXid({ alias: 'bx', sskr: '2-of-2', passphrase: PASS, updatePassphrase: UPDATE_PASS, env });
    const o = { alias: 'bx', passphrase: NEW_PASS, updatePassphrase: NEW_UPDATE_PASS, env: home('c') };
    expect(() => restoreXid({ ...o, shares: [backup.shares[1]!] })).toThrow('the shares do not restore a backup');
    expect(() => restoreXid({ ...o, shares: [backup.shares[1]!, other.shares[0]!] })).toThrow('the shares do not restore a backup');
    expect(() => restoreXid({ ...o, shares: ['ur:xid/abc'] })).toThrow('share 1: not a ur:envelope');
    expect(() => restoreXid({ ...o, shares: [] })).toThrow('no shares');
    expect(() => restoreXid({ ...o, passphrase: NEW_UPDATE_PASS, shares: backup.shares })).toThrow('must not be the release key passphrase');
    expect(() => restoreXid({ ...o, env, shares: backup.shares })).toThrow('didpkg never replaces a key');
  });

  test('refuses a bad --sskr and a wrong passphrase', () => {
    const o = { alias: 'bx', passphrase: PASS, updatePassphrase: UPDATE_PASS, env };
    for (const sskr of ['0-of-3', '4-of-3', '2-of-17', '2of3', '']) expect(() => backupXid({ ...o, sskr })).toThrow('is not <m>-of-<n>');
    expect(() => backupXid({ ...o, sskr: '2-of-3', updatePassphrase: 'a wrong passphrase' })).toThrow('wrong passphrase');
    expect(() => backupXid({ ...o, sskr: '2-of-3', passphrase: 'a wrong passphrase' })).toThrow('wrong passphrase');
  });

  test('the CLI: id backup prints one share a line, and id restore reads the share files', () => {
    const passes = { DIDPKG_PASSPHRASE: PASS, DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS };
    const b = run(['id', 'backup', 'bx', '--sskr', '2-of-3'], { ...env, ...passes });
    expect(b.err).toContain('2 of the 3 shares restore');
    expect(b.code).toBe(0);
    const lines = b.out.trim().split('\n');
    expect(lines).toHaveLength(3);
    const files = lines.map((l, i) => {
      const f = join(tmp, `share-${i + 1}.txt`);
      writeFileSync(f, `share ${i + 1} of 3\n${l}\n`);
      return f;
    });
    const r = run(['id', 'restore', 'bx', files[0]!, files[1]!], { ...home('d'), DIDPKG_PASSPHRASE: NEW_PASS, DIDPKG_UPDATE_PASSPHRASE: NEW_UPDATE_PASS });
    expect(r.err).toContain('Restored seq 1');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ alias: 'bx', xid: info.xid, seq: 1 });
    expect(run(['id', 'backup', 'bx'], { ...env, ...passes }).err).toContain('needs --sskr <m>-of-<n> one time');
    expect(run(['id', 'restore', 'bx'], env).err).toContain('needs 2 or more arguments');
  });
});
