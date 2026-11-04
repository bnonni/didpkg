#!/usr/bin/env bun
// didpkg CLI. Source: didpkg@0.0.1 (src/cli.ts). From the repo it runs on Bun 1.4.4 or later. The npm package
// is the build.ts bundle, dist/cli.js, for Node 22 or later. The CI job `package` tests it.
import { existsSync, readFileSync } from 'node:fs';
import { sidecarFile } from '@didpkg/core/did/btcr2';
import { format, parse, GrammarError } from '@didpkg/core/name';
import { xidFromUr } from '@didpkg/core/xid';
import { xidEndpoints } from '@didpkg/core/source';
import { readConfig } from './config.ts';
import { drl } from './drl.ts';
import { createBtcr2, network } from './id/btcr2.ts';
import { createDht, endpoint } from './id/dht.ts';
import { passphrase } from './id/passphrase.ts';
import { createPlc, registerPlc } from './id/plc.ts';
import { registerIdentity } from './id/register.ts';
import { configDir, idPaths, readIdentity, readIdentityFile, XID_ID_FORMAT } from './id/store.ts';
import { createWeb, documentUrl } from './id/web.ts';
import { createWebvh, logUrl } from './id/webvh.ts';
import { createXid, readXidIdentity, showXid, updateXid, type XidRole } from './id/xid.ts';
import { publish } from './publish/publish.ts';
import { publishXid } from './publish/xid.ts';
import { startShim, readSide, type ReadSideOptions } from './shim/start.ts';
import pkg from '../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

const HELP = `didpkg ${VERSION}: install names and publisher identities for packages that a DID owns

Usage:
  didpkg name <did|xid> <pkg-name>
                                  Print the install name for the DID or the XID (64 hex characters or a ur:xid) and the package name
  didpkg parse <install-name>     Print the parts of an install name as JSON
  didpkg id create <alias> [--dwn <url>] [--repo <url>]... [--relay <url>]...
                                  Make a did:dht publisher DID with the release key #didpkg-1
  didpkg id create <alias> --web <host>[:<path>]... [--dwn <url>] [--repo <url>]...
                                  Make a did:web publisher DID and its did.json to host
  didpkg id create <alias> --webvh <host>[:<path>]... [--dwn <url>] [--repo <url>]...
                                  Make a did:webvh publisher DID and its did.jsonl log to host
  didpkg id create <alias> --plc <directory> --repo <url>...
                                  Make a did:plc publisher DID and send it to the directory
  didpkg id create <alias> --btcr2 <network> --repo <url>...
                                  Make a did:btcr2 publisher DID and its genesis file to put in IPFS
  didpkg id create <alias> --xid [--dwn <url>] [--repo <url>]...
                                  Make a XID publisher: a XID document with a release key (Sign) and a DWN key (Auth)
  didpkg id update <alias> [--rotate release|dwn]... [--dwn <url>] [--remove dwn] [--repo <url>]...
                                  Change the keys or the services of a XID publisher, with the next provenance mark
  didpkg id register <alias> [--dwn <url>] [--accept-terms <hash>]
                                  Accept the terms of the DWN, then register the DID there (proof of work).
                                  For did:plc: send the DID to the directory again
  didpkg id show <alias>          Print the public data of an identity as JSON
  didpkg publish <alias> <tarball> --to dwn|dir:<path>... [--relay <url>]...
                                  Sign an npm pack tarball with the release key and write it to each target
                                  (a XID publisher: only dir:<path>)
  didpkg shim start [--port <n>] [--relay <url>]... [--cas <url>]... [--sidecar <url>]... [--xid-resolver <url>]... [--mode enforce|warn]
                    [--allow-loopback]
                                  Serve verified @didpkg packages to npm on 127.0.0.1 (default port 2092)
  didpkg drl <install-name>[@<version>] [--relay <url>]... [--cas <url>]... [--sidecar <url>]... [--allow-loopback]
                                  Verify one version as the shim does, then print the tarball URL and the signed sha512
  didpkg --help                   Print this help
  didpkg --version                Print the version

Examples:
  didpkg name did:web:nonni.org hello
  didpkg name did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y my-lib
  didpkg name 71274df133169a0e2d2ffb11cbc7917732acafa31989f685cca6cb69d473b93c hello
  didpkg parse @didpkg/hello_did_web_nonni.org
  didpkg id create main --dwn https://dwn.didpkg.dev --repo https://pkgs.example.com/
  didpkg id create web --web pkgs.example.com --dwn https://dwn.didpkg.dev --repo https://pkgs.example.com/
  didpkg id create vh --webvh pkgs.example.com:vh --repo https://pkgs.example.com/vh/
  didpkg id create plc --plc https://plc.directory --repo https://pkgs.example.com/plc/
  didpkg id create btc --btcr2 bitcoin --repo https://pkgs.example.com/btcr2/
  didpkg id create gordian --xid --dwn https://dwn.didpkg.dev --repo https://pkgs.example.com/
  didpkg id update gordian --rotate release
  didpkg id register main
  didpkg publish main hello-1.0.0.tgz --to dwn --to dir:./site
  didpkg shim start               Then add "@didpkg:registry=http://127.0.0.1:2092/" to .npmrc
  didpkg shim start --cas https://ipfs.didpkg.dev
  didpkg shim start --sidecar https://pkgs.example.com/btcr2/
  didpkg shim start --xid-resolver https://pkgs.example.com/
  didpkg drl @didpkg/hello_did_dht_eszfqrywoegyb5grhitsfrybjnce47y5n8j4ec66bgt9r6skmmwy@1.0.0

Identity files are in $DIDPKG_HOME/ids (default ~/.config/didpkg/ids). The passphrases come from
DIDPKG_PASSPHRASE (the release key, and the DWN key of a XID) and DIDPKG_UPDATE_PASSPHRASE (the update key of did:dht,
did:webvh, did:plc and did:btcr2, and the inception key of a XID), else from the terminal. The shim reads $DIDPKG_HOME/config.json if it exists: the IPFS gateways ("cas"), the Esplora
APIs ("esplora") and the Sidecar Data mirrors ("sidecar") for did:btcr2, and the XID resolvers ("xid-resolver"). The
shim and "drl" read it. The --cas, --sidecar and --xid-resolver options replace the lists of the file.

The grammar is draft 2 and can change before 1.0. See
https://github.com/bnonni/didpkg/blob/main/docs/spec/install-names.md
`;

class UsageError extends Error {}

/** The error text of the dwn-server for a DID that is not a tenant. */
const NOT_REGISTERED = 'Not a registered tenant';
/** The error text of the dwn-server for a tenant that registered with old terms of service. */
const OUTDATED_TERMS = 'Agreed terms-of-service is outdated';

/** Positional arguments and repeatable `--flag <value>` options. */
function options(args: string[], flags: string[]) {
  const positional: string[] = [];
  const values: Record<string, string[]> = Object.fromEntries(flags.map((f) => [f, []]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) positional.push(a);
    else if (!(a in values)) throw new UsageError(`unknown option ${a}`);
    else if (i + 1 >= args.length) throw new UsageError(`${a} needs a value`);
    else values[a]!.push(args[++i]!);
  }
  return { positional, values };
}

async function id(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === 'create') {
    const xid = rest.includes('--xid');
    const { positional, values } = options(rest.filter((a) => a !== '--xid'), ['--dwn', '--repo', '--relay', '--web', '--webvh', '--plc', '--btcr2']);
    if (positional.length !== 1) throw new UsageError(`"id create" needs 1 argument: <alias> (got ${positional.length})`);
    for (const f of ['--dwn', '--web', '--webvh', '--plc', '--btcr2']) if (values[f]!.length > 1) throw new UsageError(`use ${f} one time`);
    const alias = positional[0]!;
    idPaths(alias); // a bad alias fails before the passphrase prompt
    const web = values['--web']![0];
    const webvh = values['--webvh']![0];
    const plc = values['--plc']![0];
    const btcr2 = values['--btcr2']![0];
    if (web !== undefined && webvh !== undefined) throw new UsageError('use --web or --webvh, not both');
    if (plc !== undefined && (web ?? webvh) !== undefined) throw new UsageError('use --plc without --web and --webvh');
    if (btcr2 !== undefined && (web ?? webvh ?? plc) !== undefined) throw new UsageError('use --btcr2 without --web, --webvh and --plc');
    if ((web ?? webvh ?? plc ?? btcr2) !== undefined && values['--relay']!.length) throw new UsageError('--relay is for did:dht only');
    if (xid) {
      if ((web ?? webvh ?? plc ?? btcr2) !== undefined || values['--relay']!.length) throw new UsageError('use --xid without --web, --webvh, --plc, --btcr2 and --relay');
      const r = await createXid({
        alias, dwn: values['--dwn']![0], repos: values['--repo'],
        passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key and the DWN key', confirm: true }),
        updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'New passphrase for the inception key', confirm: true }),
      });
      process.stderr.write(
        `Move ${r.files.updateKey} offline. Only "didpkg id update" needs it.\n`
        + (r.documentUrls.length ? `Host ${r.files.document} at ${r.documentUrls.join(' and ')}.\n` : ''),
      );
      return `${JSON.stringify(r, null, 2)}\n`;
    }
    if (btcr2 !== undefined) {
      if (values['--dwn']!.length) throw new UsageError('--dwn is not for did:btcr2: the DWN server does not resolve did:btcr2');
      if (values['--repo']!.length === 0) throw new UsageError('--btcr2 needs --repo <url>');
      network(btcr2);
      const r = await createBtcr2({
        alias, network: btcr2, repos: values['--repo']!,
        passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key #didpkg-1', confirm: true }),
        updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'New passphrase for the update key #initialKey', confirm: true }),
      });
      process.stderr.write(
        `Move ${r.files.updateKey} offline. It is the only key that can change the DID.
`
        + `A resolver needs the genesis document. Put ${r.files.genesis} in IPFS as a raw block with the CID ${r.cid}:
`
        + `  ipfs block put --cid-codec raw --mhtype sha2-256 --pin=true ${r.files.genesis}
`
        + `Or use the Sidecar Data in ${r.files.sidecar}: "didpkg publish --to dir:<path>" writes a copy to <path>/${sidecarFile(r.did)}.
`
        + `A shim with "--sidecar <URL of the folder>" reads it.
`,
      );
      return `${JSON.stringify(r, null, 2)}
`;
    }
    if (plc !== undefined) {
      if (values['--dwn']!.length) throw new UsageError('--dwn is not for did:plc: the DWN server does not resolve did:plc');
      if (values['--repo']!.length === 0) throw new UsageError('--plc needs --repo <url>');
      endpoint(plc, '--plc');
      const r = await createPlc({
        alias, directory: plc, repos: values['--repo']!,
        passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key #didpkg-1', confirm: true }),
        updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'New passphrase for the rotation key', confirm: true }),
      });
      process.stderr.write(`Move ${r.files.updateKey} offline. It is the only key that can change the DID.\n`);
      if (!r.directory.ok) {
        process.stderr.write(`didpkg: error: the identity is saved, but the directory did not take the DID (${r.directory.error}). Run "didpkg id register ${alias}" to send it again.\n`);
        process.exitCode = 1;
      }
      return `${JSON.stringify(r, null, 2)}\n`;
    }
    if (webvh !== undefined) {
      logUrl(webvh);
      const r = await createWebvh({
        alias, webvh, dwn: values['--dwn']![0], repos: values['--repo'],
        passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key #didpkg-1', confirm: true }),
        updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'New passphrase for the update key', confirm: true }),
      });
      process.stderr.write(`Host ${r.files.log} at ${r.logUrl} and ${r.files.document} at ${r.documentUrl}. Move ${r.files.updateKey} offline. Only "didpkg id update" needs it.\n`);
      return `${JSON.stringify(r, null, 2)}\n`;
    }
    if (web !== undefined) {
      documentUrl(web);
      const r = await createWeb({
        alias, web, dwn: values['--dwn']![0], repos: values['--repo'],
        passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key #didpkg-1', confirm: true }),
      });
      process.stderr.write(`Host ${r.files.document} at ${r.documentUrl}. Then "didpkg publish" installs the DWN protocol.\n`);
      return `${JSON.stringify(r, null, 2)}\n`;
    }
    const r = await createDht({
      alias,
      dwn: values['--dwn']![0],
      repos: values['--repo'],
      relays: values['--relay']!.length ? values['--relay'] : undefined,
      passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key #didpkg-1', confirm: true }),
      updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'New passphrase for the update key #0', confirm: true }),
    });
    process.stderr.write(`Move ${r.files.updateKey} offline. Only "didpkg id update" needs it.\n`);
    const unregistered = r.dwn?.error?.includes(NOT_REGISTERED) === true;
    if (unregistered) process.stderr.write(`The DWN ${r.dwn!.url} needs a registration. Run "didpkg id register ${alias}", then "didpkg publish" installs the DWN protocol.\n`);
    const failed = [...(r.relays.some((x) => x.ok) ? [] : ['no relay accepted the DID']), ...(r.dwn && !r.dwn.ok && !unregistered ? ['the DWN protocol install failed'] : [])];
    if (failed.length) {
      process.stderr.write(`didpkg: error: the identity is saved, but ${failed.join(', and ')}. "didpkg publish" sends the DID again and installs the DWN protocol.\n`);
      process.exitCode = 1;
    }
    return `${JSON.stringify(r, null, 2)}\n`;
  }
  if (sub === 'register') {
    const { positional, values } = options(rest, ['--dwn', '--accept-terms']);
    if (positional.length !== 1) throw new UsageError(`"id register" needs 1 argument: <alias> (got ${positional.length})`);
    if (values['--dwn']!.length > 1 || values['--accept-terms']!.length > 1) throw new UsageError('use --dwn and --accept-terms one time');
    const acceptTerms = values['--accept-terms']![0];
    if (acceptTerms !== undefined && !/^[0-9a-f]{64}$/i.test(acceptTerms)) throw new UsageError('--accept-terms: use the SHA-256 hex of the terms (64 hex digits)');
    const paths = idPaths(positional[0]!);
    const reg = { dwn: values['--dwn']![0], acceptTerms: acceptTerms?.toLowerCase() };
    if (readIdentityFile(paths).format === XID_ID_FORMAT) {
      const { identity, info } = readXidIdentity(paths);
      const dwn = xidEndpoints(info).filter((e) => e.type === 'DecentralizedWebNode');
      if (dwn.length === 0) throw new Error(`the XID document has no DWN service: run "didpkg id update ${identity.alias} --dwn <url>" first`);
      const r = await registerIdentity({ alias: identity.alias, did: dwn[0]!.did, services: dwn.map((e) => e.url), ...reg });
      return `${JSON.stringify(r, null, 2)}\n`;
    }
    const identity = readIdentity(paths);
    if (identity.btcr2) throw new UsageError('"id register" is not for did:btcr2: a did:btcr2 DID has no registration');
    if (identity.plc) {
      if (values['--dwn']!.length || acceptTerms !== undefined) throw new UsageError('--dwn and --accept-terms are not for did:plc');
      const r = await registerPlc(identity);
      if (!r.ok) {
        process.stderr.write(`didpkg: error: the directory did not take the DID (${r.error}).\n`);
        process.exitCode = 1;
      }
      return `${JSON.stringify(r, null, 2)}\n`;
    }
    const services = (identity.document.service ?? []).filter((s) => s.type === 'DecentralizedWebNode')
      .flatMap((s) => s.serviceEndpoint).filter((u): u is string => typeof u === 'string');
    const r = await registerIdentity({ alias: identity.alias, did: identity.did, services, ...reg });
    return `${JSON.stringify(r, null, 2)}\n`;
  }
  if (sub === 'update') {
    const { positional, values } = options(rest, ['--rotate', '--dwn', '--remove', '--repo']);
    if (positional.length !== 1) throw new UsageError(`"id update" needs 1 argument: <alias> (got ${positional.length})`);
    if (values['--dwn']!.length > 1 || values['--remove']!.length > 1) throw new UsageError('use --dwn and --remove one time');
    for (const r of values['--rotate']!) if (r !== 'release' && r !== 'dwn') throw new UsageError(`--rotate: ${r} is not release or dwn`);
    const remove = values['--remove']![0];
    if (remove !== undefined && remove !== 'dwn') throw new UsageError(`--remove: ${remove} is not dwn`);
    if (!values['--rotate']!.length && !values['--dwn']!.length && remove === undefined && !values['--repo']!.length) {
      throw new UsageError('"id update" needs --rotate, --dwn, --remove or --repo');
    }
    const paths = idPaths(positional[0]!);
    if (readIdentityFile(paths).format !== XID_ID_FORMAT) throw new Error(`${paths.identity}: "id update" takes only a XID identity`);
    const r = await updateXid({
      alias: positional[0]!, rotate: values['--rotate'] as XidRole[], dwn: values['--dwn']![0], removeDwn: remove === 'dwn',
      repos: values['--repo']!.length ? values['--repo'] : undefined,
      updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'Passphrase for the inception key' }),
      passphrase: () => passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'Passphrase for the release key' }),
    });
    process.stderr.write(`Host ${r.files.document} again${r.documentUrls.length ? ` at ${r.documentUrls.join(' and ')}` : ''}: it has seq ${r.seq}.\n`);
    return `${JSON.stringify(r, null, 2)}\n`;
  }
  if (sub === 'show') {
    if (rest.length !== 1) throw new UsageError(`"id show" needs 1 argument: <alias> (got ${rest.length})`);
    const paths = idPaths(rest[0]!);
    if (readIdentityFile(paths).format === XID_ID_FORMAT) return `${JSON.stringify(showXid(rest[0]!), null, 2)}\n`;
    const i = readIdentity(paths);
    const out = {
      alias: i.alias, did: i.did, keyId: i.releaseKey.keyId, created: i.created,
      assertionMethod: i.document.assertionMethod, service: i.document.service ?? [],
      files: { identity: paths.identity, updateKey: existsSync(paths.updateKey) ? paths.updateKey : null },
    };
    return `${JSON.stringify(out, null, 2)}\n`;
  }
  throw new UsageError(sub === undefined ? '"id" needs a subcommand: create, update, register or show' : `unknown id subcommand ${JSON.stringify(sub)}`);
}

async function publishCommand(args: string[]): Promise<string> {
  const { positional, values } = options(args, ['--to', '--relay']);
  if (positional.length !== 2) throw new UsageError(`"publish" needs 2 arguments: <alias> <tarball> (got ${positional.length})`);
  if (values['--to']!.length === 0) throw new UsageError('"publish" needs --to dwn or --to dir:<path>');
  const [alias, file] = positional as [string, string];
  const paths = idPaths(alias);
  if (readIdentityFile(paths).format === XID_ID_FORMAT) {
    if (values['--relay']!.length) throw new UsageError('--relay: a XID publisher has no relay');
    const { identity, info } = readXidIdentity(paths);
    const r = await publishXid({
      identity,
      document: info.bytes,
      tarball: new Uint8Array(readFileSync(file)),
      to: values['--to']!,
      passphrase: () => passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'Passphrase for the XID release key' }),
    });
    const failed = r.targets.filter((t) => !t.ok).map((t) => `${t.url} failed`);
    if (failed.length) {
      process.stderr.write(`didpkg: error: ${failed.join(', and ')}. Run the same publish again: it writes the same bytes.\n`);
      process.exitCode = 1;
    }
    return `${JSON.stringify(r, null, 2)}\n`;
  }
  const identity = readIdentity(paths);
  const r = await publish({
    identity,
    tarball: new Uint8Array(readFileSync(file)),
    to: values['--to']!,
    relays: values['--relay']!.length ? values['--relay'] : undefined,
    passphrase: () => passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'Passphrase for the release key #didpkg-1' }),
  });
  const failed = [
    ...(r.relays.length && !r.relays.some((x) => x.ok) ? ['no relay accepted the DID'] : []),
    ...r.targets.filter((t) => !t.ok).map((t) => `${t.url} failed`),
  ];
  if (failed.length) {
    process.stderr.write(`didpkg: error: ${failed.join(', and ')}. Run the same publish again: it writes the same bytes.\n`);
    process.exitCode = 1;
  }
  return `${JSON.stringify(r, null, 2)}\n`;
}

/** The read side of "shim start" and "drl": the options first, else config.json. Each log line goes to stderr. */
function readOptions(values: Record<string, string[]>, allowLoopback: boolean): ReadSideOptions {
  const cas = values['--cas']!.map((u) => endpoint(u, '--cas'));
  const sidecar = values['--sidecar']!.map((u) => endpoint(u, '--sidecar'));
  const xidResolvers = (values['--xid-resolver'] ?? []).map((u) => endpoint(u, '--xid-resolver'));
  const config = readConfig();
  return {
    allowLoopback,
    relays: values['--relay']!.map((r) => endpoint(r, 'relay')),
    cas: cas.length ? cas : config.cas,
    esplora: config.esplora,
    sidecar: sidecar.length ? sidecar : config.sidecar,
    xidResolvers: xidResolvers.length ? xidResolvers : config['xid-resolver'],
    home: configDir(),
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

/** Runs until SIGINT or SIGTERM. Prints the shim URL as JSON on stdout, and one line per request on stderr. */
async function shimCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== 'start') throw new UsageError(sub === undefined ? '"shim" needs a subcommand: start' : `unknown shim subcommand ${JSON.stringify(sub)}`);
  const loopback = rest.includes('--allow-loopback');
  const { positional, values } = options(rest.filter((a) => a !== '--allow-loopback'), ['--port', '--relay', '--cas', '--sidecar', '--xid-resolver', '--mode']);
  if (positional.length !== 0) throw new UsageError(`"shim start" takes no arguments (got ${positional.length})`);
  if (values['--port']!.length > 1 || values['--mode']!.length > 1) throw new UsageError('use --port and --mode one time');
  const port = values['--port']![0] ?? '2092';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new UsageError(`--port: ${port} is not a port`);
  const mode = values['--mode']![0] ?? 'enforce';
  if (mode !== 'enforce' && mode !== 'warn') throw new UsageError(`--mode: ${mode} is not enforce or warn`);
  const shim = await startShim({ port: Number(port), mode, ...readOptions(values, loopback) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shim.stop().then(() => process.exit(0)));
  return `${JSON.stringify({ url: shim.url, npmrc: `@didpkg:registry=${shim.url}/` })}\n`;
}

/** Prints the tarball URL and the signed sha512 as JSON on stdout, and each warning on stderr. */
async function drlCommand(args: string[]): Promise<string> {
  const loopback = args.includes('--allow-loopback');
  const { positional, values } = options(args.filter((a) => a !== '--allow-loopback'), ['--relay', '--cas', '--sidecar']);
  if (positional.length !== 1) throw new UsageError(`"drl" needs 1 argument: <install-name>[@<version>] (got ${positional.length})`);
  const o = readOptions(values, loopback);
  const { warnings, ...out } = await drl({ spec: positional[0]!, ...readSide(o) });
  for (const w of warnings) o.log!(`warn ${w.code}: ${w.message}`);
  return `${JSON.stringify(out, null, 2)}\n`;
}

async function run(argv: string[]): Promise<string> {
  const [cmd, ...args] = argv;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return HELP;
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') return `${VERSION}\n`;
  if (cmd === undefined) throw new UsageError('no command');
  if (args.includes('-h') || args.includes('--help')) return HELP;
  switch (cmd) {
    case 'name': {
      if (args.length !== 2) throw new UsageError(`"name" needs 2 arguments: <did|xid> <pkg-name> (got ${args.length})`);
      const [id, pkgName] = args as [string, string];
      return `${format(/^ur:xid\//i.test(id) ? xidFromUr(id) : id, pkgName)}\n`;
    }
    case 'parse': {
      if (args.length !== 1) throw new UsageError(`"parse" needs 1 argument: <install-name> (got ${args.length})`);
      const p = parse(args[0] as string);
      const out = p.kind === 'xid' ? { kind: p.kind, form: p.form, name: p.name, xid: p.xid }
        : p.form === 'direct' ? { kind: p.kind, form: p.form, name: p.name, did: p.did }
        : { kind: p.kind, form: p.form, name: p.name, hash: p.hash };
      return `${JSON.stringify(out)}\n`;
    }
    case 'id':
      return id(args);
    case 'publish':
      return publishCommand(args);
    case 'shim':
      return shimCommand(args);
    case 'drl':
      return drlCommand(args);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
}

try {
  process.stdout.write(await run(process.argv.slice(2)));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`didpkg: error: ${e.message}\nRun "didpkg --help" for usage.\n`);
  } else if (e instanceof GrammarError) {
    process.stderr.write(`didpkg: error: ${e.message}\n`);
  } else {
    const message = e instanceof Error ? e.message : String(e);
    const hint = message.includes(NOT_REGISTERED) ? '\nThe DWN needs a registration of the DID: run "didpkg id register <alias>".'
      : message.includes(OUTDATED_TERMS) ? '\nThe terms of service of the DWN changed: run "didpkg id register <alias>" again.' : '';
    process.stderr.write(`didpkg: error: ${message}${hint}\n`);
  }
  process.exitCode = 1;
}
