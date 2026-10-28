// A Pkarr relay on 127.0.0.1 that keeps each PUT. The resolver checks the BEP44 signature on GET.
export function putRelay() {
  const store = new Map<string, Uint8Array>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const id = new URL(req.url).pathname.slice(1);
      if (req.method === 'PUT') {
        store.set(id, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      const v = store.get(id);
      return v ? new Response(v, { headers: { 'content-type': 'application/pkarr.org/relays#payload' } }) : new Response('not found', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
