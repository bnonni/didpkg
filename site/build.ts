// Builds the landing page in site/dist: the files of site/public, and the DWN protocol v1 definition at its protocol URI path.
// GitHub Pages serves a file with no extension as application/octet-stream.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DIDPKG_PROTOCOL, protocolDefinition } from '../packages/adapter-dwn/src/protocol.ts';

const dist = join(import.meta.dir, 'dist');
rmSync(dist, { recursive: true, force: true });
cpSync(join(import.meta.dir, 'public'), dist, { recursive: true });
const protocol = join(dist, new URL(DIDPKG_PROTOCOL).pathname);
mkdirSync(dirname(protocol), { recursive: true });
writeFileSync(protocol, `${JSON.stringify(protocolDefinition, null, 2)}\n`);
console.log(`Built ${dist}`);
