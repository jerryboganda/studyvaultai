import { createSyncServer } from './app.ts';
import { createJwtVerifier, staticTokenVerifier } from './auth.ts';
import { ConfigError, parseEnv } from './config.ts';
import { JsonFileStore, MemoryStore } from './store.ts';

/**
 * Entry point: `node --experimental-strip-types server/src/main.ts` (Node 22.6 to 22.17; Node 22.18
 * and later run TypeScript directly). All configuration is environment variables, see server/README.md.
 */

function main(): void {
  let parsed;
  try {
    parsed = parseEnv(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const { config, auth, storage } = parsed;

  const verifier =
    auth.kind === 'jwt'
      ? createJwtVerifier({
          issuer: auth.issuer,
          audience: auth.audience,
          jwksUri: auth.jwksUri,
          fetch,
        })
      : staticTokenVerifier(auth.tokens);
  if (auth.kind === 'static') {
    console.warn('WARNING: static development tokens are enabled. Not for production.');
  }
  const store = storage.kind === 'file' ? new JsonFileStore(storage.dir) : new MemoryStore();
  if (storage.kind === 'memory') {
    console.warn('WARNING: in-memory storage: all data is lost on restart. Not for production.');
  }

  const server = createSyncServer({ config, store, verifier });
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(JSON.stringify({ event: 'listening', host: config.host, port }));
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
