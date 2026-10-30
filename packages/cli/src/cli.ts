#!/usr/bin/env bun
// didpkg CLI. Source: didpkg@0.0.1 (src/cli.ts). From the repo it runs on Bun 1.4.4 or later. The npm package
// is the build.ts bundle, dist/cli.js, for Node 22 or later. The CI job `package` tests it.
import { existsSync, readFileSync } from 'node:fs';
import { format, parse, GrammarError } from '@didpkg/core/name';
import { createDht, endpoint } from './id/dht.ts';
import { passphrase } from './id/passphrase.ts';
import { registerIdentity } from './id/register.ts';
import { idPaths, readIdentity } from './id/store.ts';
import { createWeb, documentUrl } from './id/web.ts';
import { publish } from './publish/publish.ts';
import { startShim } from './shim/start.ts';
import pkg from '../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

const HELP = `didpkg ${VERSION}: install names and publisher identities for packages that a DID owns

Usage:
  didpkg name <did> <pkg-name>    Print the install name for the DID and the package name
  didpkg parse <install-name>     Print the parts of an install name as JSON
  didpkg id create <alias> [--dwn <url>] [--repo <url>]... [--relay <url>]...
                                  Make a did:dht publisher DID with the release key #didpkg-1
  didpkg id create <alias> --web <host>[:<path>]... [--dwn <url>] [--repo <url>]...
                                  Make a did:web publisher DID and its did.json to host
  didpkg id register <alias> [--dwn <url>] [--accept-terms <hash>]
                                  Accept the terms of the DWN, then register the DID there (proof of work)
  didpkg id show <alias>          Print the public data of an identity as JSON
  didpkg publish <alias> <tarball> --to dwn|dir:<path>... [--relay <url>]...
                                  Sign an npm pack tarball with #didpkg-1 and write it to each target
  didpkg shim start [--port <n>] [--relay <url>]... [--mode enforce|warn] [--allow-loopback]
                                  Serve verified @didpkg packages to npm on 127.0.0.1 (default port 2092)
  didpkg --help                   Print this help
  didpkg --version                Print the version

Examples:
  didpkg name did:web:nonni.org hello
  didpkg name did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y my-lib
  didpkg parse @didpkg/hello_web_nonni.org
  didpkg id create main --dwn https://dwn.didpkg.dev --repo https://me.github.io/pkgs/
  didpkg id create web --web me.github.io:pkgs --dwn https://dwn.didpkg.dev --repo https://me.github.io/pkgs/
  didpkg id register main
  didpkg publish main hello-1.0.0.tgz --to dwn --to dir:./site
  didpkg shim start               Then add "@didpkg:registry=http://127.0.0.1:2092/" to .npmrc

Identity files are in $DIDPKG_HOME/ids (default ~/.config/didpkg/ids). The passphrases come from
DIDPKG_PASSPHRASE (the release key) and DIDPKG_UPDATE_PASSPHRASE (the update key #0), else from the terminal.

The grammar is draft 1 and can change before 1.0. See
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
    const { positional, values } = options(rest, ['--dwn', '--repo', '--relay', '--web']);
    if (positional.length !== 1) throw new UsageError(`"id create" needs 1 argument: <alias> (got ${positional.length})`);
    if (values['--dwn']!.length > 1) throw new UsageError('use --dwn one time');
    if (values['--web']!.length > 1) throw new UsageError('use --web one time');
    const alias = positional[0]!;
    idPaths(alias); // a bad alias fails before the passphrase prompt
    const web = values['--web']![0];
    if (web !== undefined) {
      if (values['--relay']!.length) throw new UsageError('--relay is for did:dht only');
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
    const identity = readIdentity(idPaths(positional[0]!));
    const r = await registerIdentity({ identity, dwn: values['--dwn']![0], acceptTerms: acceptTerms?.toLowerCase() });
    return `${JSON.stringify(r, null, 2)}\n`;
  }
  if (sub === 'show') {
    if (rest.length !== 1) throw new UsageError(`"id show" needs 1 argument: <alias> (got ${rest.length})`);
    const paths = idPaths(rest[0]!);
    const i = readIdentity(paths);
    const out = {
      alias: i.alias, did: i.did, keyId: i.releaseKey.keyId, created: i.created,
      assertionMethod: i.document.assertionMethod, service: i.document.service ?? [],
      files: { identity: paths.identity, updateKey: existsSync(paths.updateKey) ? paths.updateKey : null },
    };
    return `${JSON.stringify(out, null, 2)}\n`;
  }
  throw new UsageError(sub === undefined ? '"id" needs a subcommand: create, register or show' : `unknown id subcommand ${JSON.stringify(sub)}`);
}

async function publishCommand(args: string[]): Promise<string> {
  const { positional, values } = options(args, ['--to', '--relay']);
  if (positional.length !== 2) throw new UsageError(`"publish" needs 2 arguments: <alias> <tarball> (got ${positional.length})`);
  if (values['--to']!.length === 0) throw new UsageError('"publish" needs --to dwn or --to dir:<path>');
  const [alias, file] = positional as [string, string];
  const identity = readIdentity(idPaths(alias));
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

/** Runs until SIGINT or SIGTERM. Prints the shim URL as JSON on stdout, and one line per request on stderr. */
async function shimCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== 'start') throw new UsageError(sub === undefined ? '"shim" needs a subcommand: start' : `unknown shim subcommand ${JSON.stringify(sub)}`);
  const loopback = rest.includes('--allow-loopback');
  const { positional, values } = options(rest.filter((a) => a !== '--allow-loopback'), ['--port', '--relay', '--mode']);
  if (positional.length !== 0) throw new UsageError(`"shim start" takes no arguments (got ${positional.length})`);
  if (values['--port']!.length > 1 || values['--mode']!.length > 1) throw new UsageError('use --port and --mode one time');
  const port = values['--port']![0] ?? '2092';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new UsageError(`--port: ${port} is not a port`);
  const mode = values['--mode']![0] ?? 'enforce';
  if (mode !== 'enforce' && mode !== 'warn') throw new UsageError(`--mode: ${mode} is not enforce or warn`);
  const shim = await startShim({
    port: Number(port), mode, allowLoopback: loopback,
    relays: values['--relay']!.map((r) => endpoint(r, 'relay')),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shim.stop().then(() => process.exit(0)));
  return `${JSON.stringify({ url: shim.url, npmrc: `@didpkg:registry=${shim.url}/` })}\n`;
}

async function run(argv: string[]): Promise<string> {
  const [cmd, ...args] = argv;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return HELP;
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') return `${VERSION}\n`;
  if (cmd === undefined) throw new UsageError('no command');
  if (args.includes('-h') || args.includes('--help')) return HELP;
  switch (cmd) {
    case 'name': {
      if (args.length !== 2) throw new UsageError(`"name" needs 2 arguments: <did> <pkg-name> (got ${args.length})`);
      const [did, pkgName] = args as [string, string];
      return `${format(did, pkgName)}\n`;
    }
    case 'parse': {
      if (args.length !== 1) throw new UsageError(`"parse" needs 1 argument: <install-name> (got ${args.length})`);
      const p = parse(args[0] as string);
      const out = p.form === 'direct'
        ? { form: p.form, name: p.name, did: p.did }
        : { form: p.form, name: p.name, hash: p.hash };
      return `${JSON.stringify(out)}\n`;
    }
    case 'id':
      return id(args);
    case 'publish':
      return publishCommand(args);
    case 'shim':
      return shimCommand(args);
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
