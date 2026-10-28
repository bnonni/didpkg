// The TLS parts of the demo for the did:web publisher. Both did:web resolvers use https only, and the
// dwn-server resolver refuses a loopback host name. Thus the DID host is a name that no DNS knows
// (`web.didpkg.test`), and each child that resolves it gets HTTPS_PROXY: a CONNECT proxy that sends each
// tunnel to the TLS site on 127.0.0.1. The child trusts the demo CA through NODE_EXTRA_CA_CERTS.
// openssl makes the CA and the site key in the temporary folder at run time, thus no key goes into git.
import { createServer, connect, type Socket } from 'node:net';
import { join } from 'node:path';

export const WEB_HOST = 'web.didpkg.test';

async function openssl(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(['openssl', ...args], { cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`openssl ${args[0]} (exit ${code}): ${err.trim()}`);
}

/** A demo CA and a site certificate for `host`, valid for 1 day. */
export async function makeCerts(dir: string, host: string) {
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  await openssl(['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=didpkg demo CA'], dir);
  await openssl(['req', ...ec, '-keyout', 'site.key', '-out', 'site.csr', '-subj', `/CN=${host}`], dir);
  await Bun.write(join(dir, 'site.ext'), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  await openssl(['x509', '-req', '-in', 'site.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'site.ext', '-out', 'site.pem'], dir);
  return { ca: join(dir, 'ca.pem'), cert: join(dir, 'site.pem'), key: join(dir, 'site.key') };
}

/** An HTTPS proxy on 127.0.0.1. It accepts only `CONNECT <host>:443` and connects the tunnel to the TLS site port. */
export async function startProxy(host: string, sitePort: number) {
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => s.destroy());
  };
  const server = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off('data', onData);
      client.pause();
      const [method, authority] = head.subarray(0, end).toString('latin1').split(' ');
      if (method !== 'CONNECT' || authority !== `${host}:443`) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = connect(sitePort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head.subarray(end + 4));
        client.pipe(upstream).pipe(client);
      });
      track(upstream);
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const stop = () => new Promise<void>((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  return { url: `http://127.0.0.1:${port}`, stop };
}

/** The environment of a child that resolves the did:web host: the proxy for https, and the demo CA. */
export const proxyEnv = (proxyUrl: string, caFile: string) => ({
  // Node fetch uses HTTPS_PROXY only with NODE_USE_ENV_PROXY=1. Bun ignores that variable.
  HTTPS_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: caFile, NODE_USE_ENV_PROXY: '1',
});
