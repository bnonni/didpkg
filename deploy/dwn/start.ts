// The start script of the didpkg DWN. It does what the main.js of dwn-server 0.1.45 does,
// but it gives the server the DID resolver of resolver.ts. The configuration comes from the same environment variables.
import { DwnServer } from '@enbox/dwn-server';
import { dwnDidResolver } from './resolver.ts';

const server = new DwnServer({ didResolver: dwnDidResolver() });
await server.start();
// Keep the process alive after the server starts.
await new Promise(() => {});
