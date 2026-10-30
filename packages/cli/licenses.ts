// The text of THIRD_PARTY_LICENSES.txt for a bundle: 1 section per bundled package version, with its license files.
// If the npm package has no license file, the section has the license field, the author and the repository of its
// package.json. build.ts (the npm package) and compile.ts (the standalone binaries) use it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RULE = `\n\n${'-'.repeat(80)}\n\n`;

// metafile: the Bun.build metafile. Its input paths are relative to the working folder.
export function thirdPartyLicenses(metafile: { inputs: Record<string, unknown> }, bundle: string): string {
  const roots = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (!m) continue;
    roots.add(resolve(m[1]!));
    for (const name of inlinedPackages(input)) roots.add(locate(name, m[1]!));
  }
  const sections = [...roots].map((root) => {
    const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name: string; version: string; license?: string; author?: string | { name?: string }; repository?: string | { url?: string };
    };
    const files = readdirSync(root).filter((f) => /^(licen[sc]e|copying|notice)/i.test(f)).sort();
    const author = typeof p.author === 'string' ? p.author : p.author?.name;
    const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url;
    const texts = files.length
      ? files.map((f) => readFileSync(join(root, f), 'utf8').trim())
      : [`The npm package has no license file. Author: ${author || 'not given'}. Repository: ${repo ?? 'not given'}.`];
    return { id: `${p.name}@${p.version}`, text: [`${p.name}@${p.version} (${p.license ?? 'no license field'})`, ...texts].join('\n\n') };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return `${bundle} includes these ${sections.length} packages.${RULE}${sections.map((s) => s.text).join(RULE)}\n`;
}

// A package can ship 1 file with its dependencies in it, for example didwebvh-ts.
// The bundler writes a `// <path>/node_modules/<name>/<file>` comment before the code of each inlined file.
function inlinedPackages(input: string): Set<string> {
  const names = new Set<string>();
  for (const m of readFileSync(input, 'utf8').matchAll(/^\/\/ (?:\S*\/)?node_modules\/((?:@[^/.\s][^/\s]*\/)?[^/.\s][^/\s]*)\//gm)) names.add(m[1]!);
  return names;
}

// The folder of an inlined package: in the node_modules of the package, else next to the package.
function locate(name: string, root: string): string {
  const base = root.slice(0, root.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const dir = [join(root, 'node_modules', name), base + name].find((d) => existsSync(join(d, 'package.json')));
  if (!dir) throw new Error(`${root} has the code of ${name}, but ${name} is not installed: its license is not known`);
  return resolve(dir);
}
