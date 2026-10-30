// The link check of the docs and the site. Each relative link, and each GitHub URL of a file in this repo, must have a target.
// The anchor of a link to a Markdown or HTML file must be a heading or an id in that file.
// Usage: bun site/build.ts, then bun site/check.ts. The exit code is 1 if a link has no target.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const REPO_URL = /https:\/\/github\.com\/bnonni\/didpkg\/(?:blob|tree)\/main\/([^\s"'`<>)\]]+)/g;

/** The GitHub anchor of a Markdown heading: lowercase, no punctuation, and a hyphen for each space. */
export function slug(heading: string): string {
  return heading
    .trim()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The text of a Markdown file with no fenced code blocks. */
function noFences(text: string): string {
  return text.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, '');
}

/** The anchors of a Markdown file: 1 for each heading (GitHub adds -1, -2 to a repeated slug), and each HTML id. */
export function markdownAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const count = new Map<string, number>();
  for (const [, heading] of noFences(text).matchAll(/^#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm)) {
    const base = slug(heading!);
    const n = count.get(base) ?? 0;
    count.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const [, id] of text.matchAll(/\s(?:id|name)="([^"]+)"/g)) anchors.add(id!);
  return anchors;
}

/** The relative links of a file: Markdown links and images, or HTML href and src values. */
function relativeLinks(file: string, text: string): string[] {
  const links =
    extname(file) === '.md'
      ? [...noFences(text).replace(/`[^`\n]*`/g, '').matchAll(/\]\(\s*<?([^\s)>]+)/g)]
      : extname(file) === '.html'
        ? [...text.matchAll(/\s(?:href|src)="([^"]*)"/g)]
        : [];
  return links.map((m) => m[1]!).filter((link) => !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('//'));
}

/**
 * Checks the links of each file. Gives 1 line for each link with no target.
 * root: the repo folder, for GitHub URLs and Markdown links that start with a slash.
 * site: the built site folder, for HTML files in it and their links that start with a slash.
 */
export function check(root: string, files: string[], site?: string): { links: number; problems: string[] } {
  const problems: string[] = [];
  const cache = new Map<string, Set<string>>();
  const anchors = (file: string): Set<string> => {
    let found = cache.get(file);
    if (!found) {
      const text = readFileSync(file, 'utf8');
      found = extname(file) === '.md' ? markdownAnchors(text) : new Set([...text.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1]!));
      cache.set(file, found);
    }
    return found;
  };
  /** Gives the problem of 1 link, or undefined if the link has a target. */
  const target = (from: string, base: string, link: string): string | undefined => {
    const hash = link.indexOf('#');
    const path = decodeURIComponent(hash < 0 ? link : link.slice(0, hash));
    const anchor = hash < 0 ? '' : decodeURIComponent(link.slice(hash + 1));
    let file = path === '' ? from : join(base, path);
    if (!existsSync(file)) return 'no file';
    if (!anchor) return undefined;
    if (statSync(file).isDirectory()) file = [join(file, 'index.html'), join(file, 'README.md')].find((f) => existsSync(f)) ?? file;
    if (['.md', '.html'].includes(extname(file))) return anchors(file).has(anchor) ? undefined : 'no anchor';
    return /^L\d+(?:-L\d+)?$/.test(anchor) ? undefined : 'no anchor';
  };
  const trim = (url: string) => url.replace(/[.,;:]+$/, '');
  let links = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const top = site && !relative(site, file).startsWith('..') ? site : root;
    const found = relativeLinks(file, text).map((link) => ({ link, base: link.startsWith('/') ? top : dirname(file), path: link }));
    for (const [url, path] of text.matchAll(REPO_URL)) found.push({ link: trim(url), base: root, path: trim(path!) });
    for (const { link, base, path } of found) {
      const problem = target(file, base, path);
      if (problem) problems.push(`${relative(root, file)}: ${problem}: ${link}`);
    }
    links += found.length;
  }
  return { links, problems };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const site = join(root, 'site', 'dist');
  if (!existsSync(join(site, 'index.html'))) {
    console.error('site/dist/index.html is missing. Run bun site/build.ts first.');
    process.exit(1);
  }
  const git = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '*.md', '*.ts'], { cwd: root });
  if (!git.success) throw new Error(git.stderr.toString());
  const files = [
    ...git.stdout.toString().split('\n').filter(Boolean).map((f) => join(root, f)),
    ...[...new Bun.Glob('**/*.html').scanSync(site)].map((f) => join(site, f)),
  ].filter((f) => existsSync(f));
  const { links, problems } = check(root, files, site);
  for (const problem of problems) console.error(problem);
  console.log(`${links} links in ${files.length} files. ${problems.length} links with no target.`);
  process.exit(problems.length ? 1 : 0);
}
