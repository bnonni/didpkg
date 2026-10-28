// A local static server for the adapter tests: it serves a folder under a base path, as a mirror does.
import { join } from 'node:path';

export interface StaticServer {
  base: string;
  /** Each request path, as the server got it. */
  paths: string[];
  stop(): void;
}

/** `override` can answer a request first (a status, a redirect, a hang). */
export function serveDir(dir: string, override?: (url: URL) => Response | Promise<Response> | undefined): StaticServer {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      paths.push(url.pathname);
      const answer = await override?.(url);
      if (answer) return answer;
      if (!url.pathname.startsWith('/repo/')) return new Response('not found', { status: 404 });
      const file = Bun.file(join(dir, decodeURIComponent(url.pathname.slice('/repo/'.length))));
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
  return { base: `http://127.0.0.1:${server.port}/repo/`, paths, stop: () => server.stop(true) };
}
