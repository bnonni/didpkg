#!/usr/bin/env bun
// didpkg CLI. Source: didpkg@0.0.1 (src/cli.ts). It needs Bun 1.4.4 or later, the same floor as the shim.
import { format, parse, GrammarError } from '@didpkg/core/name';
import pkg from '../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

const HELP = `didpkg ${VERSION}: install-name codec for packages that a DID owns

Usage:
  didpkg name <did> <pkg-name>    Print the install name for the DID and the package name
  didpkg parse <install-name>     Print the parts of an install name as JSON
  didpkg --help                   Print this help
  didpkg --version                Print the version

Examples:
  didpkg name did:web:nonni.org hello
  didpkg name did:dht:i9xkp8ddcbcg8jwq54ox699wuzxyifsqx4jru45zodqu453ksz6y my-lib
  didpkg parse @didpkg/hello_web_nonni.org

The grammar is draft 1 and can change before 1.0. See https://didpkg.dev.
`;

class UsageError extends Error {}

function run(argv: string[]): string {
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
    default:
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
}

try {
  process.stdout.write(run(process.argv.slice(2)));
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
