#!/usr/bin/env bun
// didpkg CLI. Source: didpkg@0.0.1 (src/cli.ts). It needs Bun 1.4.4 or later, the same floor as the shim.
import { existsSync, readFileSync } from 'node:fs';
import { format, parse, GrammarError } from '@didpkg/core/name';
import { createDht, endpoint } from './id/dht.ts';
import { passphrase } from './id/passphrase.ts';
import { idPaths, readIdentity } from './id/store.ts';
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
  didpkg publish main hello-1.0.0.tgz --to dwn --to dir:./site
  didpkg shim start               Then add "@didpkg:registry=http://127.0.0.1:2092/" to .npmrc

Identity files are in $DIDPKG_HOME/ids (default ~/.config/didpkg/ids). The passphrases come from
DIDPKG_PASSPHRASE (the release key) and DIDPKG_UPDATE_PASSPHRASE (the update key #0), else from the terminal.

The grammar is draft 1 and can change before 1.0. See https://didpkg.dev.
`;

class UsageError extends Error {}

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
    const { positional, values } = options(rest, ['--dwn', '--repo', '--relay']);
    if (positional.length !== 1) throw new UsageError(`"id create" needs 1 argument: <alias> (got ${positional.length})`);
    if (values['--dwn']!.length > 1) throw new UsageError('use --dwn one time');
    const alias = positional[0]!;
    idPaths(alias); // a bad alias fails before the passphrase prompt
    const r = await createDht({
      alias,
      dwn: values['--dwn']![0],
      repos: values['--repo'],
      relays: values['--relay']!.length ? values['--relay'] : undefined,
      passphrase: await passphrase({ env: 'DIDPKG_PASSPHRASE', prompt: 'New passphrase for the release key #didpkg-1', confirm: true }),
      updatePassphrase: await passphrase({ env: 'DIDPKG_UPDATE_PASSPHRASE', prompt: 'New passphrase for the update key #0', confirm: true }),
    });
    process.stderr.write(`Move ${r.files.updateKey} offline. Only "didpkg id update" needs it.\n`);
    const failed = [...(r.relays.some((x) => x.ok) ? [] : ['no relay accepted the DID']), ...(r.dwn && !r.dwn.ok ? ['the DWN protocol install failed'] : [])];
    if (failed.length) {
      process.stderr.write(`didpkg: error: the identity is saved, but ${failed.join(', and ')}. "didpkg publish" sends the DID again and installs the DWN protocol.\n`);
      process.exitCode = 1;
    }
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
  throw new UsageError(sub === undefined ? '"id" needs a subcommand: create or show' : `unknown id subcommand ${JSON.stringify(sub)}`);
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
  const shim = startShim({
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
    process.stderr.write(`didpkg: error: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.exitCode = 1;
}
