// `didpkg id register`: the tenant registration of a DID on a DWN (@enbox/dwn-server 0.1.45). The CLI shows the terms of
// service, and the user accepts them on the terminal or with `--accept-terms <hash>`. Then the CLI does the proof of work:
// at the server default, about 2^24 hashes (about 30 s). The registration needs no key and no DID resolution.
import { createInterface } from 'node:readline/promises';
import { getTerms, register, type Terms } from '@didpkg/adapter-dwn/registration';
import { endpoint } from './dht.ts';
import type { Identity } from './store.ts';

export interface RegisterResult {
  alias: string;
  did: string;
  dwn: string;
  /** The hash of the terms that the user accepted, or null if the DWN has no terms. */
  termsOfServiceHash: string | null;
}

const say = (text: string) => process.stderr.write(text);

/** `--dwn`, else the one URL of the DecentralizedWebNode services of the identity. */
function dwnOf(identity: Identity, dwn?: string): string {
  if (dwn !== undefined) return endpoint(dwn, '--dwn');
  const urls = [...new Set((identity.document.service ?? []).filter((s) => s.type === 'DecentralizedWebNode')
    .flatMap((s) => s.serviceEndpoint).filter((u): u is string => typeof u === 'string'))];
  if (urls.length === 0) throw new Error('the identity has no DecentralizedWebNode service: use --dwn <url>');
  if (urls.length > 1) throw new Error(`the identity has ${urls.length} DWN URLs: use --dwn <url> to select one`);
  return endpoint(urls[0]!, 'dwn');
}

/** Each control character as \xNN, so that a server cannot hide text or move the cursor. */
const visible = (text: string) => text.replace(/\r\n/g, '\n')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** A y/N question on the terminal. Ctrl-C and Ctrl-D are a no. */
async function yes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const stop = new AbortController();
  rl.on('SIGINT', () => stop.abort());
  rl.on('close', () => stop.abort());
  try {
    return /^y(es)?$/i.test((await rl.question(question, { signal: stop.signal })).trim());
  } catch {
    say('\n');
    return false;
  } finally {
    rl.close();
  }
}

/** `accept`: the lowercase hash from `--accept-terms`. Without it, the CLI shows the terms and asks on the terminal. */
async function agree(url: string, terms: Terms, accept?: string): Promise<void> {
  if (accept === terms.hash) {
    say(`You accepted the terms of service of ${url} with --accept-terms ${terms.hash}.\n`);
    return;
  }
  say(`The terms of service of ${url} (SHA-256 ${terms.hash}):\n\n${visible(terms.text).trimEnd()}\n\n`);
  if (accept !== undefined) throw new Error(`--accept-terms ${accept} is not the hash of these terms. Read them, then use --accept-terms ${terms.hash}`);
  if (!process.stdin.isTTY) throw new Error(`no terminal to ask: read the terms, then use --accept-terms ${terms.hash}`);
  if (!(await yes('Do you accept these terms? [y/N] '))) throw new Error('you did not accept the terms, so the CLI did not register the DID');
}

/** A progress line on stderr: one line that changes on a terminal, else one line each 10 s. */
function progress() {
  const tty = process.stderr.isTTY === true;
  const t0 = performance.now();
  let last = -Infinity;
  const m = (n: number) => `${(n / 1e6).toFixed(1)} M`;
  return {
    onProgress(hashes: number, average: number) {
      const now = performance.now();
      if (now - last < (tty ? 500 : 10_000)) return;
      last = now;
      const s = (now - t0) / 1000;
      const line = `Proof of work: ${m(hashes)} hashes in ${Math.round(s)} s. The average is ${m(average)} hashes (about ${Math.round(average / (hashes / s))} s).`;
      say(tty ? `\r${line}\x1b[K` : `${line}\n`);
    },
    end: () => { if (tty && last > -Infinity) say('\n'); },
  };
}

export async function registerIdentity(o: { identity: Identity; dwn?: string; acceptTerms?: string }): Promise<RegisterResult> {
  const { alias, did } = o.identity;
  const url = dwnOf(o.identity, o.dwn);
  const terms = await getTerms(url).catch((e: Error) => { throw new Error(`cannot get the terms of service of ${url}: ${e.message}`); });
  if (terms) await agree(url, terms, o.acceptTerms);
  else if (o.acceptTerms !== undefined) throw new Error(`${url} has no terms of service: remove --accept-terms`);
  say('Proof of work for the registration. Ctrl-C stops it.\n');
  const p = progress();
  try {
    await register(url, did, { terms, onProgress: p.onProgress });
  } finally {
    p.end();
  }
  say(`Registered ${did} on ${url}. Next: "didpkg publish ${alias} <tarball> --to dwn" installs the DWN protocol and writes.\n`);
  return { alias, did, dwn: url, termsOfServiceHash: terms?.hash ?? null };
}
