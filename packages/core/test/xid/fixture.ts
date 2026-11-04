// XID documents from fixed seeds. Ed25519 signatures are deterministic, so the bytes are the same on each run.
import { PrivateKeyBase } from '@blockchaincommons/components';
import { ProvenanceMark } from '@blockchaincommons/provenance-mark';
import { Key, Permissions, Service, XIDDocument } from '@blockchaincommons/xid';

const seed = (b: number): Uint8Array => new Uint8Array(32).fill(b);
export const GENESIS_DATE = new Date('2026-11-04T00:00:00Z');

export interface DocOptions {
  /** The number of provenance marks after the genesis mark. */
  seq?: number;
  /** The seed byte of the inception key. Another byte gives another XID. */
  inception?: number;
  /** The seed byte of the provenance chain. Another byte gives another chain id. */
  chain?: number;
  /** The date of the last mark. */
  date?: Date;
  provenance?: boolean;
  sign?: boolean;
  /** Replace the last mark with this mark. */
  mark?: (last: ProvenanceMark) => ProvenanceMark;
}

/** A publisher document: inception key (All), release key (Sign), DWN key (Auth) and a DWN service. */
export function publisherDoc(o: DocOptions = {}): XIDDocument {
  const inc = PrivateKeyBase.from(seed(o.inception ?? 1));
  const genesis = o.provenance === false ? undefined : { seed: seed(o.chain ?? 3), resolution: 'low' as const, date: GENESIS_DATE };
  const doc = XIDDocument.from({ inceptionKey: { publicKeys: inc.ed25519PublicKeys(), privateKeys: inc.ed25519PrivateKeys() }, genesis });
  doc.addKey(Key.from(PrivateKeyBase.from(seed(2)).ed25519PublicKeys(), { nickname: 'release', permissions: Permissions.from({ allow: ['Sign'] }) }));
  const dwn = Key.from(PrivateKeyBase.from(seed(4)).ed25519PublicKeys(), { nickname: 'dwn', permissions: Permissions.from({ allow: ['Auth'] }) });
  doc.addKey(dwn);
  doc.addResolutionMethod(`https://mirror.example/xid/${doc.xid.toHex()}.envelope`);
  doc.addService(Service.from('https://dwn.example', { capability: 'dwn', keyReferences: [dwn.reference], permissions: Permissions.from({ allow: ['Auth'] }) }));
  const seq = o.seq ?? 0;
  for (let i = 1; i <= seq; i++) doc.nextProvenanceMarkWithEmbeddedGenerator({ date: i === seq && o.date ? o.date : new Date(GENESIS_DATE.getTime() + i * 86_400_000) });
  if (o.mark) doc.setProvenance(o.mark(doc.provenance!));
  return doc;
}

/** The signed document as tagged CBOR. */
export function docBytes(o: DocOptions = {}): Uint8Array {
  return publisherDoc(o).toEnvelope({ sign: o.sign === false ? 'none' : 'inception' }).toCbor().toData();
}

/** A mark with the chain id and seq of `last`, but a key that is not in the chain. */
export function strayMark(last: ProvenanceMark): ProvenanceMark {
  return ProvenanceMark.from({ res: last.res, key: seed(9).slice(0, last.key.length), nextKey: seed(8).slice(0, last.key.length), chainId: last.chainId, seq: last.seq, date: last.date });
}

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
