// `didpkg id create --xid`, `didpkg id show` and `didpkg id update` for a XID publisher.
// Each lock and each open of a key costs one Argon2id run (about 0.5 s). Thus the tests share the identities.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Envelope } from '@blockchaincommons/envelope';
import { addSignatures, hasSignatureFrom } from '@blockchaincommons/envelope/signature';
import { XIDDocument } from '@blockchaincommons/xid';
import { checkProvenance, readXidDocument, xidFromUr } from '@didpkg/core/xid';
import { base64urlnopad } from '@scure/base';
import { idPaths } from '../src/id/store.ts';
import { createXid, openXidKey, readXidIdentity, updateXid } from '../src/id/xid.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'didpkg-id-xid-'));
const env = { DIDPKG_HOME: tmp };
const PASS = 'release passphrase 1';
const UPDATE_PASS = 'update passphrase 1';
const DATE = new Date('2026-11-04T12:00:00Z');
const mode = (f: string) => statSync(f).mode & 0o777;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH!, DIDPKG_HOME: tmp, ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe('id create --xid', async () => {
  const r = await createXid({
    alias: 'gx', dwn: 'https://dwn.example', repos: ['https://pkgs.example.com/x/'], passphrase: PASS, updatePassphrase: UPDATE_PASS, env, date: DATE,
  });
  const paths = idPaths('gx', env);
  const { identity, info } = readXidIdentity(paths);

  test('writes the identity, the update key and the document to host, with the file modes', () => {
    expect(mode(paths.identity)).toBe(0o600);
    expect(mode(paths.xidUpdate)).toBe(0o600);
    expect(mode(paths.xidDocument)).toBe(0o644);
    expect(mode(paths.dir)).toBe(0o700);
    expect(hex(readFileSync(paths.xidDocument))).toBe(hex(base64urlnopad.decode(identity.document)));
    expect(r.files).toEqual({ identity: paths.identity, updateKey: paths.xidUpdate, document: paths.xidDocument });
  });

  test('the document has the inception key, a Sign key, an Auth key, 2 services and the provenance genesis', () => {
    expect(r.xid).toMatch(/^[0-9a-f]{64}$/);
    expect(xidFromUr(r.ur)).toBe(r.xid);
    expect(info.provenance.seq).toBe(0);
    expect(info.provenance.date).toBe(DATE.toISOString());
    const byName = Object.fromEntries(info.keys.map((k) => [k.nickname, k]));
    expect(Object.keys(byName).sort()).toEqual(['dwn', 'inception', 'release']);
    expect([byName.inception!.inception, byName.inception!.allow]).toEqual([true, ['All']]);
    expect([byName.release!.inception, byName.release!.allow]).toEqual([false, ['Sign']]);
    expect([byName.dwn!.inception, byName.dwn!.allow]).toEqual([false, ['Auth']]);
    expect(info.services.map((s) => [s.uri, s.capability, s.keyReferences, s.allow]).sort()).toEqual([
      ['https://dwn.example', 'DecentralizedWebNode', [byName.dwn!.reference], ['Auth']],
      ['https://pkgs.example.com/x/', 'DIDPackageRepository', [byName.release!.reference], ['Sign']],
    ]);
    expect([...info.dereferenceVia]).toEqual([`https://pkgs.example.com/x/xid/${r.xid}.envelope`]);
    expect(r.documentUrls).toEqual([...info.dereferenceVia]);
  });

  test('the files hold no private key in the clear', () => {
    const doc = XIDDocument.fromEnvelope(Envelope.fromBytes(readFileSync(paths.xidUpdate)), { verify: 'inception' });
    expect(doc.inceptionPrivateKeys).toBeUndefined();
    expect(doc.inceptionKey!.hasEncryptedPrivateKeys).toBe(true);
    expect(doc.provenanceGenerator).toBeUndefined();
    expect(XIDDocument.fromEnvelope(Envelope.fromBytes(base64urlnopad.decode(identity.document))).keys.some((k) => k.hasPrivateKeys || k.hasEncryptedPrivateKeys)).toBe(false);
  });

  test('the update key file opens with the passphrase and gives the same document', () => {
    const doc = XIDDocument.fromEnvelope(Envelope.fromBytes(readFileSync(paths.xidUpdate)), { password: UPDATE_PASS, verify: 'inception' });
    expect(doc.inceptionPrivateKeys).toBeDefined();
    expect(doc.provenanceGenerator).toBeDefined();
    expect(hex(doc.toEnvelope({ sign: 'inception' }).toCbor().toData())).toBe(hex(info.bytes));
  });

  test('the release key opens with the passphrase and signs as the Sign key of the document', () => {
    const signed = addSignatures(Envelope.fromBytes(info.bytes), [openXidKey(identity, 'release', PASS)]);
    expect(hasSignatureFrom(signed, info.keys.find((k) => k.nickname === 'release')!.key)).toBe(true);
    expect(hasSignatureFrom(signed, info.keys.find((k) => k.nickname === 'dwn')!.key)).toBe(false);
    expect(() => openXidKey(identity, 'release', 'not the passphrase')).toThrow('wrong passphrase');
  });

  test('refuses an alias with files, and the same passphrase for 2 keys', async () => {
    await expect(createXid({ alias: 'gx', passphrase: PASS, updatePassphrase: UPDATE_PASS, env })).rejects.toThrow('never replaces a key');
    await expect(createXid({ alias: 'gy', passphrase: PASS, updatePassphrase: PASS, env })).rejects.toThrow('must not be');
    await expect(createXid({ alias: 'gy', repos: ['http://pkgs.example.com/'], passphrase: PASS, updatePassphrase: UPDATE_PASS, env })).rejects.toThrow('https');
    expect(existsSync(idPaths('gy', env).identity)).toBe(false);
  });
});

describe('id update', async () => {
  await createXid({ alias: 'gu', repos: ['https://a.example/'], passphrase: PASS, updatePassphrase: UPDATE_PASS, env, date: DATE });
  const paths = idPaths('gu', env);
  const before = readXidIdentity(paths);
  const keyOf = (i: ReturnType<typeof readXidIdentity>, name: string) => i.info.keys.find((k) => k.nickname === name);

  test('a wrong update passphrase changes no file', async () => {
    const bytes = readFileSync(paths.xidUpdate);
    await expect(updateXid({ alias: 'gu', repos: ['https://b.example/'], updatePassphrase: 'not the passphrase', env })).rejects.toThrow('wrong passphrase');
    expect(readFileSync(paths.xidUpdate)).toEqual(bytes);
  });

  test('--rotate release: a new Sign key, the services follow it, and the next mark follows the chain', async () => {
    const r = await updateXid({ alias: 'gu', rotate: ['release'], passphrase: async () => PASS, updatePassphrase: UPDATE_PASS, env });
    const after = readXidIdentity(paths);
    expect(r.seq).toBe(1);
    expect(after.info.xid).toBe(before.info.xid);
    checkProvenance(before.info.provenance, after.info.provenance);
    const [oldKey, newKey] = [keyOf(before, 'release')!, keyOf(after, 'release')!];
    expect(newKey.reference).not.toBe(oldKey.reference);
    expect(after.info.keys.map((k) => k.reference)).not.toContain(oldKey.reference);
    expect(after.info.services[0]!.keyReferences).toEqual([newKey.reference]);
    expect(after.identity.keys.previousRelease).toBe(before.identity.keys.release);
    const signed = addSignatures(Envelope.fromBytes(after.info.bytes), [openXidKey(after.identity, 'release', PASS)]);
    expect(hasSignatureFrom(signed, newKey.key)).toBe(true);
    expect(hasSignatureFrom(addSignatures(Envelope.fromBytes(after.info.bytes), [openXidKey(after.identity, 'previousRelease', PASS)]), oldKey.key)).toBe(true);
    expect(hex(readFileSync(paths.xidDocument))).toBe(hex(after.info.bytes));
    expect(mode(paths.identity)).toBe(0o600);
    expect(mode(paths.xidDocument)).toBe(0o644);
  });

  test('a new key needs the release passphrase of the identity', async () => {
    await expect(updateXid({ alias: 'gu', rotate: ['release'], passphrase: async () => 'not the passphrase', updatePassphrase: UPDATE_PASS, env })).rejects.toThrow('wrong passphrase');
    await expect(updateXid({ alias: 'gu', rotate: ['release'], updatePassphrase: UPDATE_PASS, env })).rejects.toThrow('release passphrase');
    expect(readXidIdentity(paths).info.provenance.seq).toBe(1);
  });

  test('--dwn adds a DWN key and a service, --remove dwn removes them, --repo replaces the mirrors', async () => {
    let ask = 0;
    await updateXid({ alias: 'gu', dwn: 'https://dwn.example', passphrase: async () => (ask++, PASS), updatePassphrase: UPDATE_PASS, env });
    let i = readXidIdentity(paths);
    expect(keyOf(i, 'dwn')!.allow).toEqual(['Auth']);
    expect(i.info.services.find((s) => s.capability === 'DecentralizedWebNode')!.keyReferences).toEqual([keyOf(i, 'dwn')!.reference]);
    const firstDwn = keyOf(i, 'dwn')!.reference;
    await updateXid({ alias: 'gu', rotate: ['dwn'], passphrase: async () => (ask++, PASS), updatePassphrase: UPDATE_PASS, env });
    i = readXidIdentity(paths);
    expect(keyOf(i, 'dwn')!.reference).not.toBe(firstDwn);
    expect(i.info.services.find((s) => s.capability === 'DecentralizedWebNode')!.keyReferences).toEqual([keyOf(i, 'dwn')!.reference]);
    expect(i.identity.keys.previousRelease).toBe(before.identity.keys.release); // a DWN rotation keeps the release keys
    await updateXid({ alias: 'gu', repos: ['https://b.example/', 'https://c.example/'], passphrase: async () => (ask++, PASS), updatePassphrase: UPDATE_PASS, env });
    i = readXidIdentity(paths);
    expect(ask).toBe(2); // only a new key asked for the release passphrase
    expect([...i.info.dereferenceVia].sort()).toEqual([`https://b.example/xid/${i.info.xid}.envelope`, `https://c.example/xid/${i.info.xid}.envelope`]);
    expect(i.info.services.filter((s) => s.capability === 'DIDPackageRepository').map((s) => s.uri).sort()).toEqual(['https://b.example/', 'https://c.example/']);
    await updateXid({ alias: 'gu', removeDwn: true, updatePassphrase: UPDATE_PASS, env });
    i = readXidIdentity(paths);
    expect(keyOf(i, 'dwn')).toBeUndefined();
    expect(i.identity.keys.dwn).toBeUndefined();
    expect(i.info.services.some((s) => s.capability === 'DecentralizedWebNode')).toBe(false);
    expect(i.info.provenance.seq).toBe(5);
  });
});

describe('the CLI', () => {
  const pass = { DIDPKG_PASSPHRASE: PASS, DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS };

  test('id create --xid, id show and id update', () => {
    const c = run(['id', 'create', 'cx', '--xid', '--repo', 'https://pkgs.example.com/'], pass);
    expect(c.err).toContain('Move ');
    expect(c.code).toBe(0);
    const created = JSON.parse(c.out);
    expect(created.seq).toBe(0);
    const s = run(['id', 'show', 'cx']);
    expect(s.code).toBe(0);
    const shown = JSON.parse(s.out);
    expect([shown.kind, shown.xid, shown.ur, shown.provenance.seq]).toEqual(['xid', created.xid, created.ur, 0]);
    expect(shown.files.updateKey).toBe(created.files.updateKey);
    const u = run(['id', 'update', 'cx', '--repo', 'https://b.example/'], { DIDPKG_UPDATE_PASSPHRASE: UPDATE_PASS });
    expect(u.code).toBe(0);
    expect(JSON.parse(u.out).documentUrls).toEqual([`https://b.example/xid/${created.xid}.envelope`]);
    expect(JSON.parse(run(['id', 'show', 'cx']).out).provenance.seq).toBe(1);
  });

  test('refuses bad options, and a XID identity in a command for a DID', () => {
    expect(run(['id', 'create', 'cy', '--xid', '--web', 'example.com'], pass).err).toContain('use --xid without');
    expect(run(['id', 'update', 'cx'], pass).err).toContain('needs --rotate, --dwn, --remove or --repo');
    expect(run(['id', 'update', 'cx', '--rotate', 'inception'], pass).err).toContain('is not release or dwn');
    expect(run(['id', 'update', 'cx', '--remove', 'release'], pass).err).toContain('is not dwn');
    const p = run(['id', 'register', 'cx'], pass);
    expect([p.code, p.err.includes('the XID document has no DWN service')]).toEqual([1, true]);
  });
});
